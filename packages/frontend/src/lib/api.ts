import axios from 'axios'

export const api = axios.create({
  baseURL: '/api/v1',
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    const isLoginRequest = (err.config?.url ?? '').includes('/auth/login')
    if (err.response?.status === 401 && !isLoginRequest && window.location.pathname !== '/login') {
      window.location.href = '/login'
    }
    const msg = err.response?.data?.error ?? err.message
    return Promise.reject(new Error(typeof msg === 'string' ? msg : JSON.stringify(msg)))
  },
)

export const fetcher = (url: string) => api.get(url).then((r) => r.data)
