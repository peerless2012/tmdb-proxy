export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    }

    // 处理预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders })
    }

    try {
      const url = new URL(request.url)
      
      // 图片代理处理
      if (url.pathname.startsWith('/image/')) {
        return await handleImageProxy(request, url, corsHeaders)
      }
      
      // API 代理处理
      return await handleApiProxy(request, url, env, ctx, corsHeaders)

    } catch (error) {
      return new Response(JSON.stringify({ 
        error: 'Proxy error', 
        message: error.message 
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        }
      })
    }
  }
}

// 处理图片代理
async function handleImageProxy(request, url, corsHeaders) {
  // 从路径中提取图片路径
  // 格式: /image/path/to/image.jpg 或 /image/t/p/w500/abc123.jpg
  const imagePath = url.pathname.replace('/image', '')
  
  if (!imagePath) {
    return new Response(JSON.stringify({ error: 'Image path required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    })
  }

  // 构建 TMDB 图片 URL
  const imageUrl = `https://image.tmdb.org${imagePath}`
  
  // 获取图片
  const response = await fetch(imageUrl)
  
  if (!response.ok) {
    return new Response(JSON.stringify({ 
      error: 'Image not found',
      url: imageUrl 
    }), {
      status: response.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    })
  }

  // 创建响应并设置正确的 Content-Type
  const contentType = response.headers.get('content-type') || 'image/jpeg'
  const imageBuffer = await response.arrayBuffer()
  
  return new Response(imageBuffer, {
    status: response.status,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=86400', // 缓存1天
      ...corsHeaders
    }
  })
}

// 处理 API 代理
async function handleApiProxy(request, url, env, ctx, corsHeaders) {
  let apiPath = url.pathname

  // 去掉代理前缀
  if (apiPath.startsWith('/proxy')) {
    apiPath = apiPath.replace('/proxy', '')
  }

  const searchParams = new URLSearchParams(url.searchParams)

  // 确定 API Key 来源：用户传入 > 环境变量
  let apiKey = searchParams.get('api_key') // 用户通过查询参数传入
  let bearerToken = null

  if (!apiKey) {
    // 检查 Authorization header（Bearer token）
    const authHeader = request.headers.get('Authorization')
    if (authHeader && authHeader.startsWith('Bearer ')) {
      bearerToken = authHeader.substring(7)
    }
  }

  if (!apiKey && !bearerToken) {
    // 都没有，用环境变量
    if (env.TMDB_API_KEY) {
      apiKey = env.TMDB_API_KEY
    } else {
      return new Response(JSON.stringify({ error: 'API key not configured' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      })
    }
  }

  // --- 缓存逻辑（仅 GET 请求） ---
  const cache = typeof caches !== 'undefined' ? caches.default : null
  let cacheKey = null

  if (cache && request.method === 'GET') {
    // 构建缓存 key：用路径 + 去掉 api_key 的查询参数
    const cacheParams = new URLSearchParams(url.searchParams)
    cacheParams.delete('api_key') // 去掉 key，让不同用户共享缓存
    const cacheUrl = new URL(url.origin + apiPath)
    cacheUrl.search = cacheParams.toString()
    cacheKey = new Request(cacheUrl.toString(), { method: 'GET' })

    // 尝试从缓存读取
    const cachedResponse = await cache.match(cacheKey)
    if (cachedResponse) {
      return cachedResponse
    }
  }

  // --- 请求上游 ---
  if (apiKey) {
    searchParams.set('api_key', apiKey)
  }
  // 确保缓存 key 参数不会污染上游请求
  const upstreamParams = new URLSearchParams(searchParams)
  const apiUrl = `https://api.tmdb.org${apiPath}?${upstreamParams}`

  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  }
  if (bearerToken && !apiKey) {
    headers['Authorization'] = `Bearer ${bearerToken}`
  }

  const response = await fetchWithRetry(apiUrl, {
    method: request.method,
    headers,
  })

  // 非成功响应不缓存，直接返回
  if (!response.ok) {
    const modifiedResponse = new Response(response.body, response)
    Object.entries(corsHeaders).forEach(([key, value]) => {
      modifiedResponse.headers.set(key, value)
    })
    return modifiedResponse
  }

  // 构建响应
  const responseBody = await response.text()
  const ttl = getCacheTtl(apiPath)
  const newResponse = new Response(responseBody, {
    status: response.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${ttl}`,
      ...corsHeaders
    }
  })

  // 写入缓存（仅 GET 请求，不阻塞响应返回）
  if (cache && cacheKey) {
    ctx.waitUntil(cache.put(cacheKey, newResponse.clone()))
  }

  return newResponse
}

// 请求上游，遇到 429 自动重试
async function fetchWithRetry(url, options, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    const response = await fetch(url, options)
    if (response.status === 429 && i < retries) {
      await new Promise(r => setTimeout(r, (i + 1) * 1000))
      continue
    }
    return response
  }
}

// 根据 API 路径决定缓存时长（秒）
function getCacheTtl(path) {
  // 热映/即将上映/流行/趋势列表 - 1 小时
  if (path.includes('/now_playing') || path.includes('/upcoming') ||
      path.includes('/popular') || path.includes('/trending')) {
    return 3600
  }
  // 搜索结果 - 30 分钟
  if (path.includes('/search/')) {
    return 1800
  }
  // 电影/剧集详情 - 24 小时
  if (path.match(/\/(movie|tv)\/\d+/)) {
    return 86400
  }
  // 默认 6 小时
  return 21600
}
