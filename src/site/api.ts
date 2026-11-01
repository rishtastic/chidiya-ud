import type { Candidate } from '../game/types'

export interface Account {
    username: string
    contentEditor: boolean
    userAdmin: boolean
    superAdmin: boolean
    csrf: string
}

const base = `${import.meta.env.BASE_URL}api`
let account: Account | null = null

export function currentAccount(): Account | null {
    return account
}

export async function request<T>(path: string, method = 'GET', body?: unknown, authenticated = false): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (authenticated) headers['X-CSRF-Token'] = account?.csrf ?? ''
    const response = await fetch(`${base}${path}`, {
        method,
        credentials: 'same-origin',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? 'Request failed. Please try again.')
    }
    return response.json() as Promise<T>
}

export async function loadAccount(): Promise<Account | null> {
    try {
        account = await request<Account>('/auth/me')
    } catch {
        account = null
    }
    return account
}

export async function login(username: string, password: string): Promise<Account> {
    account = await request<Account>('/auth/login', 'POST', { username, password })
    return account
}

export async function register(username: string, password: string): Promise<string> {
    const result = await request<{ recoveryCode: string }>('/auth/register', 'POST', { username, password })
    await loadAccount()
    return result.recoveryCode
}

export async function logout(): Promise<void> {
    await request('/auth/logout', 'POST', {}, true)
    account = null
}

export async function resetPassword(username: string, token: string, password: string): Promise<void> {
    await request('/auth/reset', 'POST', { username, token, password })
    account = null
}

export async function endGuestSession(): Promise<void> {
    await request('/guest/end', 'POST', {})
}

export async function loadPublishedItems(): Promise<Record<'english' | 'hindi', Candidate[]>> {
    const data = await request<{ items: Array<Candidate & { language: 'english' | 'hindi' }> }>('/items')
    const lists: Record<'english' | 'hindi', Candidate[]> = { english: [], hindi: [] }
    data.items.forEach((item) => {
        if (item.language in lists) lists[item.language].push(item)
    })
    return lists
}
