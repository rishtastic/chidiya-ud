import { currentAccount, loadAccount, login, logout, register, resetPassword } from './api'

type Mode = 'login' | 'register' | 'reset' | 'account'

export function installAccountUI(): void {
    const tools = document.createElement('nav')
    tools.className = 'site-tools'
    tools.setAttribute('aria-label', 'Game links')
    tools.innerHTML = `
        <a href="${import.meta.env.BASE_URL}leaderboard/">Full leaderboard</a>
        <a id="admin-link" href="${import.meta.env.BASE_URL}admin/">Admin</a>
        <button id="account-trigger" class="text-button" type="button">Sign in</button>
    `
    document.querySelector('.site-shell')?.prepend(tools)

    const dialog = document.createElement('dialog')
    dialog.className = 'account-dialog'
    dialog.setAttribute('aria-labelledby', 'account-title')
    dialog.innerHTML = `
        <div class="account-dialog-inner">
            <button id="account-close" class="dialog-close" type="button" aria-label="Close">×</button>
            <h2 id="account-title">Sign in</h2>
            <p id="account-message" class="account-message"></p>
            <form id="account-form">
                <label for="account-name">Your name</label>
                <input id="account-name" name="username" maxlength="24" autocomplete="username" required />
                <label id="reset-code-label" for="reset-code" hidden>Reset code</label>
                <input id="reset-code" name="resetCode" autocomplete="off" hidden />
                <label for="account-password">Password</label>
                <input id="account-password" name="password" type="password" autocomplete="current-password" required />
                <label id="confirm-label" for="confirm-password" hidden>Confirm password</label>
                <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" hidden />
                <p id="account-error" class="field-error" role="alert"></p>
                <button id="account-submit" class="start-button" type="submit">Sign in</button>
            </form>
            <div id="recovery-reveal" hidden>
                <p>Keep this recovery code somewhere safe. It will not be shown again.</p>
                <code id="recovery-value"></code>
                <button id="copy-recovery" class="text-button" type="button">Copy code</button>
            </div>
            <div class="account-switch">
                <button id="show-login" class="text-button" type="button">Sign in</button>
                <button id="show-register" class="text-button" type="button">Create account</button>
                <button id="show-reset" class="text-button" type="button">Use a reset code</button>
                <button id="account-logout" class="text-button" type="button" hidden>Sign out</button>
            </div>
        </div>
    `
    document.body.append(dialog)

    const form = dialog.querySelector<HTMLFormElement>('#account-form')!
    const name = dialog.querySelector<HTMLInputElement>('#account-name')!
    const password = dialog.querySelector<HTMLInputElement>('#account-password')!
    const confirmation = dialog.querySelector<HTMLInputElement>('#confirm-password')!
    const resetCode = dialog.querySelector<HTMLInputElement>('#reset-code')!
    const error = dialog.querySelector<HTMLElement>('#account-error')!
    const message = dialog.querySelector<HTMLElement>('#account-message')!
    const submit = dialog.querySelector<HTMLButtonElement>('#account-submit')!
    let mode: Mode = 'login'
    let sessionName = ''

    const updateTools = () => {
        const account = currentAccount()
        tools.querySelector<HTMLButtonElement>('#account-trigger')!.textContent = account?.username ?? 'Sign in'
        tools.querySelector<HTMLButtonElement>('#account-trigger')!.title = account?.username ?? 'Sign in'
        document.dispatchEvent(new Event('chidiya:account-change'))
    }

    const showMode = (next: Mode) => {
        mode = next
        error.textContent = ''
        message.textContent = ''
        dialog.querySelector<HTMLElement>('#recovery-reveal')!.hidden = true
        form.hidden = next === 'account'
        dialog.querySelector<HTMLElement>('#account-title')!.textContent = {
            login: 'Sign in', register: 'Save your name', reset: 'Reset password', account: 'Your account',
        }[next]
        dialog.querySelector<HTMLElement>('#confirm-label')!.hidden = next !== 'register'
        confirmation.hidden = next !== 'register'
        confirmation.required = next === 'register'
        dialog.querySelector<HTMLElement>('#reset-code-label')!.hidden = next !== 'reset'
        resetCode.hidden = next !== 'reset'
        resetCode.required = next === 'reset'
        password.autocomplete = next === 'login' ? 'current-password' : 'new-password'
        submit.textContent = { login: 'Sign in', register: 'Save my name', reset: 'Set new password', account: '' }[next]
        dialog.querySelector<HTMLButtonElement>('#account-logout')!.hidden = next !== 'account'
        dialog.querySelector<HTMLButtonElement>('#show-login')!.hidden = next === 'login'
        dialog.querySelector<HTMLButtonElement>('#show-register')!.hidden = next === 'register' || next === 'account'
        dialog.querySelector<HTMLButtonElement>('#show-reset')!.hidden = next === 'reset' || next === 'account'
        if (next === 'account') message.textContent = `Signed in as ${currentAccount()?.username ?? ''}.`
    }

    const open = (next: Mode, username = '') => {
        form.reset()
        sessionName = next === 'register' ? username : ''
        name.value = username || currentAccount()?.username || document.querySelector<HTMLInputElement>('#player')?.value || ''
        showMode(next)
        name.readOnly = !!sessionName
        if (sessionName) message.textContent = `This will attach games played as ${sessionName} in this session. Earlier scores need admin approval.`
        dialog.showModal()
        if (next !== 'account') (sessionName ? password : name).focus()
    }

    tools.querySelector('#account-trigger')?.addEventListener('click', () => open(currentAccount() ? 'account' : 'login'))
    document.addEventListener('chidiya:session-change', updateTools)
    dialog.querySelector('#account-close')?.addEventListener('click', () => dialog.close())
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close() })
    dialog.querySelector('#show-login')?.addEventListener('click', () => { sessionName = ''; name.readOnly = false; showMode('login') })
    dialog.querySelector('#show-register')?.addEventListener('click', () => { sessionName = ''; name.readOnly = false; showMode('register') })
    dialog.querySelector('#show-reset')?.addEventListener('click', () => { sessionName = ''; name.readOnly = false; showMode('reset') })
    dialog.querySelector('#account-logout')?.addEventListener('click', async () => {
        try { await logout(); dialog.close(); updateTools() }
        catch (cause) { error.textContent = cause instanceof Error ? cause.message : 'Could not sign out.' }
    })
    dialog.querySelector('#copy-recovery')?.addEventListener('click', async () => {
        const code = dialog.querySelector<HTMLElement>('#recovery-value')!.textContent ?? ''
        await navigator.clipboard.writeText(code)
        message.textContent = 'Recovery code copied.'
    })
    document.addEventListener('chidiya:save-name', (event) => {
        const requested = (event as CustomEvent<{ name: string }>).detail.name
        open('register', requested)
    })

    form.addEventListener('submit', async (event) => {
        event.preventDefault()
        error.textContent = ''
        if (mode === 'register' && password.value !== confirmation.value) {
            error.textContent = 'Passwords do not match.'
            return
        }
        submit.disabled = true
        try {
            if (mode === 'login') {
                const signedIn = await login(name.value.trim(), password.value)
                dialog.close()
                const player = document.querySelector<HTMLInputElement>('#player')
                if (player) { player.value = signedIn.username; player.dispatchEvent(new Event('input')) }
                updateTools()
            } else if (mode === 'register') {
                const code = await register(name.value.trim(), password.value)
                form.hidden = true
                dialog.querySelector<HTMLElement>('#recovery-reveal')!.hidden = false
                dialog.querySelector<HTMLElement>('#recovery-value')!.textContent = code
                dialog.querySelector<HTMLElement>('#account-title')!.textContent = 'Name saved'
                document.querySelector<HTMLElement>('#save-name-prompt')?.remove()
                updateTools()
            } else if (mode === 'reset') {
                await resetPassword(name.value.trim(), resetCode.value.trim(), password.value)
                password.value = ''
                showMode('login')
                message.textContent = 'Password changed. Sign in with the new one.'
                updateTools()
            }
        } catch (cause) {
            error.textContent = cause instanceof Error ? cause.message : 'Request failed.'
        } finally {
            submit.disabled = false
        }
    })

    void loadAccount().then(() => {
        updateTools()
        const player = document.querySelector<HTMLInputElement>('#player')
        if (player && currentAccount() && !player.value) {
            player.value = currentAccount()!.username
            player.dispatchEvent(new Event('input'))
        }
    })
}
