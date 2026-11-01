import '../style.css'
import './site.css'
import { currentAccount, loadAccount, login, logout, request, type Account } from './api'

interface Item {
    id: number
    language: 'english' | 'hindi'
    name: string
    spoken: string
    canFly: boolean
    explanation: string
    active: boolean
    draft?: Item
}
interface Score {
    id: number
    rank: number
    player: string
    score: number
    createdAt: string
    accountId?: number
    accountName?: string
    isPrivate?: boolean
}
interface User {
    id: number
    username: string
    contentEditor: boolean
    userAdmin: boolean
    scoreCount: number
}

const loginSection = document.querySelector<HTMLElement>('#admin-login')!
const workspace = document.querySelector<HTMLElement>('#admin-workspace')!
const tabs = document.querySelector<HTMLElement>('#admin-tabs')!
const status = document.querySelector<HTMLElement>('#admin-status')!
const panels = {
    items: document.querySelector<HTMLElement>('#items-panel')!,
    scores: document.querySelector<HTMLElement>('#scores-panel')!,
    users: document.querySelector<HTMLElement>('#users-panel')!,
}
type Tab = keyof typeof panels
type ItemColumn = 'item' | 'language' | 'answer' | 'status'
type SortDirection = 'asc' | 'desc'
const itemColumns: ItemColumn[] = ['item', 'language', 'answer', 'status']
const itemColumnLabels: Record<ItemColumn, string> = { item: 'Item', language: 'Language', answer: 'Answer', status: 'Status' }
const itemFilters: Record<ItemColumn, Set<string> | null> = { item: null, language: null, answer: null, status: null }
const itemCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
let activeTab: Tab = 'items'
let allItems: Item[] = []
let selectedItem: Item | null = null
let itemSort: { column: ItemColumn; direction: SortDirection } | null = null
let openItemFilter: HTMLElement | null = null
let scorePage = 1
let userPage = 1
let includePrivate = false

const cell = (row: HTMLTableRowElement, text: string) => {
    const value = row.insertCell()
    value.textContent = text
    return value
}
const button = (text: string, action: () => void) => {
    const value = document.createElement('button')
    value.type = 'button'
    value.textContent = text
    value.addEventListener('click', action)
    return value
}
const setStatus = (value: string) => { status.textContent = value }
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'Request failed.'

function showWorkspace(account: Account): void {
    const authorized = account.superAdmin || account.contentEditor || account.userAdmin
    loginSection.hidden = authorized
    workspace.hidden = !authorized
    document.querySelector<HTMLElement>('#admin-signout')!.hidden = !authorized
    if (!authorized) return
    document.querySelector<HTMLElement>('#admin-identity')!.textContent = `Signed in as ${account.username}`
    tabs.replaceChildren()
    const available: Tab[] = []
    if (account.contentEditor) available.push('items')
    if (account.userAdmin) available.push('scores', 'users')
    if (!available.includes(activeTab)) activeTab = available[0]
    for (const tab of available) {
        const control = button({ items: 'Items', scores: 'Scores', users: 'Users' }[tab], () => showTab(tab))
        control.className = 'admin-tab'
        control.setAttribute('aria-current', String(tab === activeTab))
        tabs.append(control)
    }
    showTab(activeTab)
}

function showTab(tab: Tab): void {
    closeItemFilter()
    activeTab = tab
    for (const [key, panel] of Object.entries(panels)) panel.hidden = key !== tab
    tabs.querySelectorAll<HTMLButtonElement>('button').forEach((control) => control.setAttribute('aria-current', String(control.textContent?.toLowerCase() === tab)))
    setStatus('')
    if (tab === 'items') void loadItems()
    if (tab === 'scores') void loadScores()
    if (tab === 'users') void loadUsers()
}

function buildItemsPanel(): void {
    panels.items.innerHTML = `
        <div class="panel-heading"><h2>Items</h2><button id="new-item" type="button">New item</button></div>
        <div class="admin-split">
            <div>
                <div class="filter-row"><label for="item-search">Search name</label><input id="item-search" type="search" placeholder="Item name" /><label class="check-label"><input id="missing-explanation" type="checkbox" /> Missing explanation</label></div>
                <p id="item-count" class="item-count" role="status"></p>
                <div class="table-scroll"><table class="data-table item-table"><thead><tr>${itemColumns.map((column) => `<th scope="col" data-column="${column}"><span class="item-th-content"><span>${itemColumnLabels[column]}</span><button type="button" class="item-filter-trigger" data-filter="${column}" aria-label="Filter and sort ${itemColumnLabels[column]}" aria-haspopup="dialog" aria-expanded="false" title="Filter and sort ${itemColumnLabels[column]}">▾</button></span></th>`).join('')}</tr></thead><tbody id="item-rows"></tbody></table></div>
            </div>
            <form id="item-form" class="field-stack item-editor">
                <h3 id="item-form-title">Select an item</h3>
                <label for="edit-language">Language</label><select id="edit-language" required><option value="english">English</option><option value="hindi">Hindi</option></select>
                <label for="edit-name">Displayed word</label><input id="edit-name" maxlength="80" required />
                <label for="edit-spoken">Spoken word</label><input id="edit-spoken" maxlength="160" required />
                <label class="check-label"><input id="edit-can-fly" type="checkbox" /> Can fly</label>
                <label for="edit-explanation">Explanation shown after a loss</label><textarea id="edit-explanation" maxlength="1000" rows="5"></textarea>
                <label class="check-label"><input id="edit-active" type="checkbox" checked /> Live in the game after publishing</label>
                <label id="answer-confirm-label" class="check-label" hidden><input id="answer-confirm" type="checkbox" /> I confirm this changes the flying answer</label>
                <p id="item-error" class="field-error" role="alert"></p>
                <div class="editor-actions"><button id="save-draft" type="submit">Save draft</button><button id="publish-item" type="button">Publish</button></div>
            </form>
        </div>
    `
    panels.items.querySelector('#new-item')?.addEventListener('click', () => selectItem(null))
    panels.items.querySelector('#item-search')?.addEventListener('input', renderItemRows)
    panels.items.querySelector('#missing-explanation')?.addEventListener('change', renderItemRows)
    panels.items.querySelectorAll<HTMLButtonElement>('.item-filter-trigger').forEach((trigger) => {
        trigger.addEventListener('click', () => showItemFilter(trigger, trigger.dataset.filter as ItemColumn))
    })
    panels.items.querySelector('#edit-can-fly')?.addEventListener('change', updateAnswerConfirmation)
    panels.items.querySelector<HTMLFormElement>('#item-form')!.addEventListener('submit', (event) => { event.preventDefault(); void saveDraft() })
    panels.items.querySelector('#publish-item')?.addEventListener('click', async () => {
        const confirmAnswerChange = panels.items.querySelector<HTMLInputElement>('#answer-confirm')!.checked
        const id = await saveDraft()
        if (!id) return
        try {
            const result = await request<{ published: boolean }>(`/admin/items/${id}/publish`, 'POST', { confirmAnswerChange }, true)
            setStatus(result.published ? 'Item is live.' : 'Item is not live.')
            await loadItems()
        } catch (cause) { panels.items.querySelector<HTMLElement>('#item-error')!.textContent = errorMessage(cause) }
    })
}

async function loadItems(): Promise<void> {
    if (!panels.items.querySelector('#item-form')) buildItemsPanel()
    try {
        const result = await request<{ items: Item[] }>('/admin/items')
        allItems = result.items
        selectedItem = selectedItem && allItems.find((item) => item.id === selectedItem!.id) || null
        closeItemFilter()
        renderItemRows()
        if (selectedItem) selectItem(selectedItem)
    } catch (cause) { setStatus(errorMessage(cause)) }
}

function itemValue(item: Item, column: ItemColumn): string {
    const visible = item.draft ?? item
    if (column === 'item') return visible.name
    if (column === 'language') return visible.language === 'english' ? 'English' : 'Hindi'
    if (column === 'answer') return visible.canFly ? 'Can fly' : 'Cannot fly'
    return `${item.active ? 'Live' : 'Not live'}${item.draft ? ' · Draft' : ''}`
}

function closeItemFilter(restoreFocus = false): void {
    if (!openItemFilter) return
    const column = openItemFilter.dataset.column
    openItemFilter.remove()
    openItemFilter = null
    panels.items.querySelectorAll<HTMLButtonElement>('.item-filter-trigger').forEach((trigger) => trigger.setAttribute('aria-expanded', 'false'))
    if (restoreFocus) panels.items.querySelector<HTMLButtonElement>(`.item-filter-trigger[data-filter="${column}"]`)?.focus()
}

function showItemFilter(trigger: HTMLButtonElement, column: ItemColumn): void {
    if (openItemFilter?.dataset.column === column) {
        closeItemFilter()
        return
    }
    closeItemFilter()
    const values = [...new Set(allItems.map((item) => itemValue(item, column)))].sort(itemCollator.compare)
    const selected = new Set(itemFilters[column] ?? values)
    const menu = document.createElement('div')
    menu.className = 'item-filter-menu'
    menu.dataset.column = column
    menu.setAttribute('role', 'dialog')
    menu.setAttribute('aria-label', `Filter and sort ${itemColumnLabels[column]}`)
    menu.innerHTML = `
        <div class="item-sort-actions"><button type="button" data-sort="asc">Sort A to Z</button><button type="button" data-sort="desc">Sort Z to A</button><button type="button" data-clear-sort>Clear sort</button></div>
        <div class="item-filter-values"><label class="check-label"><input type="checkbox" data-select-all /> Select all</label><div class="item-filter-options"></div></div>
        <div class="item-filter-actions"><button type="button" data-clear-filter>Clear filter</button><button type="button" data-cancel>Cancel</button><button type="button" data-apply>Apply</button></div>
    `
    const options = menu.querySelector<HTMLElement>('.item-filter-options')!
    for (const value of values) {
        const label = document.createElement('label')
        label.className = 'check-label'
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.value = value
        checkbox.checked = selected.has(value)
        label.append(checkbox, document.createTextNode(value))
        options.append(label)
    }
    const checkboxes = [...options.querySelectorAll<HTMLInputElement>('input')]
    const selectAll = menu.querySelector<HTMLInputElement>('[data-select-all]')!
    const syncSelectAll = () => {
        const checked = checkboxes.filter((checkbox) => checkbox.checked).length
        selectAll.checked = checked === checkboxes.length
        selectAll.indeterminate = checked > 0 && checked < checkboxes.length
    }
    syncSelectAll()
    selectAll.addEventListener('change', () => { checkboxes.forEach((checkbox) => { checkbox.checked = selectAll.checked }); syncSelectAll() })
    options.addEventListener('change', syncSelectAll)
    menu.querySelectorAll<HTMLButtonElement>('[data-sort]').forEach((control) => {
        const direction = control.dataset.sort as SortDirection
        control.setAttribute('aria-pressed', String(itemSort?.column === column && itemSort.direction === direction))
        control.addEventListener('click', () => { itemSort = { column, direction }; closeItemFilter(true); renderItemRows() })
    })
    menu.querySelector<HTMLButtonElement>('[data-clear-sort]')!.disabled = itemSort?.column !== column
    menu.querySelector('[data-clear-sort]')?.addEventListener('click', () => { itemSort = null; closeItemFilter(true); renderItemRows() })
    menu.querySelector<HTMLButtonElement>('[data-clear-filter]')!.disabled = itemFilters[column] === null
    menu.querySelector('[data-clear-filter]')?.addEventListener('click', () => { itemFilters[column] = null; closeItemFilter(true); renderItemRows() })
    menu.querySelector('[data-cancel]')?.addEventListener('click', () => closeItemFilter(true))
    menu.querySelector('[data-apply]')?.addEventListener('click', () => {
        const chosen = checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value)
        itemFilters[column] = chosen.length === values.length ? null : new Set(chosen)
        closeItemFilter(true)
        renderItemRows()
    })
    menu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); closeItemFilter(true) }
    })
    document.body.append(menu)
    openItemFilter = menu
    trigger.setAttribute('aria-expanded', 'true')
    const rect = trigger.getBoundingClientRect()
    const width = document.documentElement.clientWidth
    const height = document.documentElement.clientHeight
    menu.style.left = `${Math.max(8, Math.min(rect.left, width - menu.offsetWidth - 8))}px`
    const below = rect.bottom + 4
    menu.style.top = `${below + menu.offsetHeight <= height - 8 ? below : Math.max(8, Math.min(rect.top - menu.offsetHeight - 4, height - menu.offsetHeight - 8))}px`
    menu.querySelector<HTMLButtonElement>('[data-sort]')?.focus()
}

document.addEventListener('pointerdown', (event) => {
    if (!openItemFilter || !(event.target instanceof Element)) return
    if (!openItemFilter.contains(event.target) && !event.target.closest('.item-filter-trigger')) closeItemFilter()
})
document.addEventListener('scroll', (event) => {
    if (openItemFilter && event.target instanceof Node && !openItemFilter.contains(event.target)) closeItemFilter()
}, true)

function renderItemRows(): void {
    const rows = panels.items.querySelector<HTMLTableSectionElement>('#item-rows')!
    const search = panels.items.querySelector<HTMLInputElement>('#item-search')!.value.trim().toLowerCase()
    const missing = panels.items.querySelector<HTMLInputElement>('#missing-explanation')!.checked
    const visibleItems = allItems.filter((item) => {
        const visible = item.draft ?? item
        if (search && !visible.name.toLowerCase().includes(search)) return false
        if (missing && visible.explanation.trim()) return false
        return itemColumns.every((column) => !itemFilters[column] || itemFilters[column].has(itemValue(item, column)))
    })
    if (itemSort) {
        const { column, direction } = itemSort
        visibleItems.sort((first, second) => direction === 'asc'
            ? itemCollator.compare(itemValue(first, column), itemValue(second, column)) || first.id - second.id
            : itemCollator.compare(itemValue(second, column), itemValue(first, column)) || first.id - second.id)
    }
    panels.items.querySelector<HTMLElement>('#item-count')!.textContent = `${visibleItems.length} of ${allItems.length} items`
    panels.items.querySelectorAll<HTMLTableCellElement>('th[data-column]').forEach((header) => {
        const column = header.dataset.column as ItemColumn
        const sorted = itemSort?.column === column
        header.setAttribute('aria-sort', sorted ? (itemSort?.direction === 'asc' ? 'ascending' : 'descending') : 'none')
        const trigger = header.querySelector<HTMLButtonElement>('.item-filter-trigger')!
        trigger.classList.toggle('is-filtered', itemFilters[column] !== null)
        trigger.textContent = sorted ? (itemSort?.direction === 'asc' ? '↑' : '↓') : '▾'
    })
    rows.replaceChildren()
    if (visibleItems.length === 0) {
        const empty = rows.insertRow().insertCell()
        empty.colSpan = itemColumns.length
        empty.className = 'item-empty'
        empty.textContent = 'No items match these filters.'
        return
    }
    for (const item of visibleItems) {
        const visible = item.draft ?? item
        const row = rows.insertRow()
        row.classList.toggle('selected', item.id === selectedItem?.id)
        const select = button(visible.name, () => selectItem(item))
        select.className = 'item-select'
        cell(row, '').append(select)
        cell(row, itemValue(item, 'language'))
        cell(row, itemValue(item, 'answer'))
        cell(row, itemValue(item, 'status'))
    }
}

function selectItem(item: Item | null): void {
    selectedItem = item
    const data = item?.draft ?? item
    panels.items.querySelector<HTMLElement>('#item-form-title')!.textContent = item ? `Edit ${item.name}` : 'New item'
    panels.items.querySelector<HTMLSelectElement>('#edit-language')!.value = data?.language ?? 'english'
    panels.items.querySelector<HTMLInputElement>('#edit-name')!.value = data?.name ?? ''
    panels.items.querySelector<HTMLInputElement>('#edit-spoken')!.value = data?.spoken ?? ''
    panels.items.querySelector<HTMLInputElement>('#edit-can-fly')!.checked = data?.canFly ?? false
    panels.items.querySelector<HTMLTextAreaElement>('#edit-explanation')!.value = data?.explanation ?? ''
    panels.items.querySelector<HTMLInputElement>('#edit-active')!.checked = data?.active ?? true
    panels.items.querySelector<HTMLInputElement>('#answer-confirm')!.checked = false
    panels.items.querySelector<HTMLElement>('#item-error')!.textContent = ''
    updateAnswerConfirmation()
    renderItemRows()
}

function updateAnswerConfirmation(): void {
    const changed = !!selectedItem?.active && selectedItem.canFly !== panels.items.querySelector<HTMLInputElement>('#edit-can-fly')!.checked
    panels.items.querySelector<HTMLElement>('#answer-confirm-label')!.hidden = !changed
}

async function saveDraft(): Promise<number | null> {
    const form = panels.items.querySelector<HTMLFormElement>('#item-form')!
    if (!form.reportValidity()) return null
    const data = {
        language: panels.items.querySelector<HTMLSelectElement>('#edit-language')!.value as Item['language'],
        name: panels.items.querySelector<HTMLInputElement>('#edit-name')!.value.trim(),
        spoken: panels.items.querySelector<HTMLInputElement>('#edit-spoken')!.value.trim(),
        canFly: panels.items.querySelector<HTMLInputElement>('#edit-can-fly')!.checked,
        explanation: panels.items.querySelector<HTMLTextAreaElement>('#edit-explanation')!.value.trim(),
        active: panels.items.querySelector<HTMLInputElement>('#edit-active')!.checked,
    }
    try {
        let id = selectedItem?.id
        if (id) await request(`/admin/items/${id}/draft`, 'PUT', data, true)
        else { id = (await request<{ id: number }>('/admin/items', 'POST', data, true)).id }
        panels.items.querySelector<HTMLElement>('#item-error')!.textContent = ''
        setStatus('Draft saved. The published version is unchanged.')
        selectedItem = { id, ...data }
        await loadItems()
        return id
    } catch (cause) {
        panels.items.querySelector<HTMLElement>('#item-error')!.textContent = errorMessage(cause)
        return null
    }
}

function buildScoresPanel(): void {
    panels.scores.innerHTML = `
        <div class="panel-heading"><h2>Scores</h2></div>
        <div class="filter-row"><label for="score-search">Search names</label><input id="score-search" type="search" /><label class="check-label"><input id="include-private" type="checkbox" /> Include private scores</label></div>
        <p id="score-count" class="data-status"></p>
        <div class="table-scroll"><table class="data-table"><thead><tr><th>Rank</th><th>Player</th><th>Score</th><th>Date</th><th>Account</th><th>Action</th></tr></thead><tbody id="admin-score-rows"></tbody></table></div>
        <nav class="pager" aria-label="Score pages"><button id="score-previous" type="button">Previous</button><span id="score-page"></span><button id="score-next" type="button">Next</button></nav>
    `
    const search = panels.scores.querySelector<HTMLInputElement>('#score-search')!
    let debounce: number | undefined
    search.addEventListener('input', () => { clearTimeout(debounce); debounce = window.setTimeout(() => { scorePage = 1; void loadScores() }, 250) })
    panels.scores.querySelector<HTMLInputElement>('#include-private')!.addEventListener('change', (event) => {
        includePrivate = (event.target as HTMLInputElement).checked
        scorePage = 1
        void loadScores()
    })
    panels.scores.querySelector('#score-previous')?.addEventListener('click', () => { scorePage -= 1; void loadScores() })
    panels.scores.querySelector('#score-next')?.addEventListener('click', () => { scorePage += 1; void loadScores() })
}

async function loadScores(): Promise<void> {
    if (!panels.scores.querySelector('#admin-score-rows')) buildScoresPanel()
    const search = panels.scores.querySelector<HTMLInputElement>('#score-search')!.value.trim()
    const params = new URLSearchParams({ page: String(scorePage), search, includePrivate: String(includePrivate) })
    try {
        const result = await request<{ scores: Score[]; total: number; pageSize: number }>(`/admin/scores?${params}`)
        const rows = panels.scores.querySelector<HTMLTableSectionElement>('#admin-score-rows')!
        rows.replaceChildren()
        for (const score of result.scores) {
            const row = rows.insertRow()
            cell(row, `#${score.rank}`)
            cell(row, score.player)
            cell(row, String(score.score))
            cell(row, new Date(score.createdAt).toLocaleDateString())
            cell(row, score.accountName || 'Unclaimed')
            const action = cell(row, '')
            if (!score.isPrivate) {
                action.append(score.accountId
                    ? button('Reverse claim', () => { void reverseClaim(score) })
                    : button('Claim', () => { void openClaim(score).catch((cause) => setStatus(errorMessage(cause))) }))
            }
        }
        panels.scores.querySelector<HTMLElement>('#score-count')!.textContent = `${result.total} scores · ${includePrivate ? 'All-score ranks' : 'Public ranks'}`
        panels.scores.querySelector<HTMLElement>('#score-page')!.textContent = `Page ${scorePage} of ${Math.max(1, Math.ceil(result.total / result.pageSize))}`
        panels.scores.querySelector<HTMLButtonElement>('#score-previous')!.disabled = scorePage === 1
        panels.scores.querySelector<HTMLButtonElement>('#score-next')!.disabled = scorePage * result.pageSize >= result.total
    } catch (cause) { setStatus(errorMessage(cause)) }
}

async function reverseClaim(score: Score): Promise<void> {
    try {
        await request(`/admin/scores/${score.id}/unclaim`, 'POST', {}, true)
        setStatus(`Claim for ${score.player}'s score reversed.`)
        await loadScores()
    } catch (cause) { setStatus(errorMessage(cause)) }
}

function buildUsersPanel(): void {
    panels.users.innerHTML = `
        <div class="panel-heading"><h2>Users</h2></div>
        <div class="filter-row"><label for="user-search">Search names</label><input id="user-search" type="search" /></div>
        <div class="table-scroll"><table class="data-table"><thead><tr><th>Username</th><th>Scores</th><th>Roles</th><th>Actions</th></tr></thead><tbody id="admin-user-rows"></tbody></table></div>
        <nav class="pager" aria-label="User pages"><button id="user-previous" type="button">Previous</button><span id="user-page"></span><button id="user-next" type="button">Next</button></nav>
    `
    let debounce: number | undefined
    panels.users.querySelector<HTMLInputElement>('#user-search')!.addEventListener('input', () => { clearTimeout(debounce); debounce = window.setTimeout(() => { userPage = 1; void loadUsers() }, 250) })
    panels.users.querySelector('#user-previous')?.addEventListener('click', () => { userPage -= 1; void loadUsers() })
    panels.users.querySelector('#user-next')?.addEventListener('click', () => { userPage += 1; void loadUsers() })
}

async function loadUsers(): Promise<void> {
    if (!panels.users.querySelector('#admin-user-rows')) buildUsersPanel()
    const search = panels.users.querySelector<HTMLInputElement>('#user-search')!.value.trim()
    try {
        const result = await request<{ users: User[]; page: number }>(`/admin/users?${new URLSearchParams({ search, page: String(userPage) })}`)
        const rows = panels.users.querySelector<HTMLTableSectionElement>('#admin-user-rows')!
        rows.replaceChildren()
        for (const user of result.users) {
            const row = rows.insertRow()
            cell(row, user.username)
            cell(row, String(user.scoreCount))
            cell(row, [user.contentEditor && 'Content editor', user.userAdmin && 'User admin'].filter(Boolean).join(', ') || 'Player')
            const actions = cell(row, '')
            const canReset = currentAccount()?.superAdmin || !(user.contentEditor || user.userAdmin)
            if (canReset) actions.append(button('Reset password', () => openReset(user)))
            if (currentAccount()?.superAdmin) actions.append(button('Roles', () => openRoles(user)))
        }
        panels.users.querySelector<HTMLElement>('#user-page')!.textContent = `Page ${userPage}`
        panels.users.querySelector<HTMLButtonElement>('#user-previous')!.disabled = userPage === 1
        panels.users.querySelector<HTMLButtonElement>('#user-next')!.disabled = result.users.length < 50
    } catch (cause) { setStatus(errorMessage(cause)) }
}

const dialog = document.createElement('dialog')
dialog.className = 'admin-dialog'
dialog.setAttribute('aria-labelledby', 'dialog-title')
dialog.innerHTML = `<form id="admin-dialog-form" class="field-stack"><h2 id="dialog-title"></h2><div id="dialog-fields"></div><p id="dialog-error" class="field-error" role="alert"></p><div class="editor-actions"><button id="dialog-submit" type="submit">Save</button><button id="dialog-cancel" type="button">Cancel</button></div></form><div id="dialog-result" hidden></div>`
document.body.append(dialog)
dialog.querySelector('#dialog-cancel')?.addEventListener('click', () => dialog.close())
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close() })

function showDialog(title: string, fields: string, submitText: string, action: (form: HTMLFormElement) => Promise<void>): void {
    const form = dialog.querySelector<HTMLFormElement>('#admin-dialog-form')!
    form.hidden = false
    dialog.querySelector<HTMLElement>('#dialog-result')!.hidden = true
    dialog.querySelector<HTMLElement>('#dialog-title')!.textContent = title
    dialog.querySelector<HTMLElement>('#dialog-fields')!.innerHTML = fields
    dialog.querySelector<HTMLElement>('#dialog-error')!.textContent = ''
    dialog.querySelector<HTMLButtonElement>('#dialog-submit')!.textContent = submitText
    form.onsubmit = async (event) => {
        event.preventDefault()
        const control = dialog.querySelector<HTMLButtonElement>('#dialog-submit')!
        control.disabled = true
        try { await action(form) }
        catch (cause) { dialog.querySelector<HTMLElement>('#dialog-error')!.textContent = errorMessage(cause) }
        finally { control.disabled = false }
    }
    dialog.showModal()
}

async function openClaim(score: Score): Promise<void> {
    const match = await request<{ id: number; username: string }>(`/admin/users/lookup?${new URLSearchParams({ username: score.player })}`)
    showDialog(`Claim score for ${score.player}`, '<p id="claim-summary"></p>', 'Approve claim', async () => {
        await request(`/admin/scores/${score.id}/claim`, 'POST', { accountId: match.id }, true)
        dialog.close()
        setStatus('Score claim approved.')
        await loadScores()
    })
    dialog.querySelector<HTMLElement>('#claim-summary')!.textContent = `Assign this ${score.score}-point score to the account ${match.username}?`
}

function openReset(user: User): void {
    showDialog(`Reset ${user.username}`, `<label for="verification-note">How was this request verified?</label><textarea id="verification-note" minlength="10" maxlength="500" rows="3" required></textarea><label for="recovery-code">Recovery code (optional)</label><input id="recovery-code" autocomplete="off" />`, 'Create reset code', async () => {
        const verificationNote = dialog.querySelector<HTMLTextAreaElement>('#verification-note')!.value.trim()
        const recoveryCode = dialog.querySelector<HTMLInputElement>('#recovery-code')!.value.trim()
        const result = await request<{ resetCode: string }>(`/admin/users/${user.id}/reset`, 'POST', { verificationNote, recoveryCode }, true)
        dialog.querySelector<HTMLFormElement>('#admin-dialog-form')!.hidden = true
        const output = dialog.querySelector<HTMLElement>('#dialog-result')!
        output.hidden = false
        output.replaceChildren()
        const message = document.createElement('p')
        message.textContent = `Give this one-use code to ${user.username}. It expires in 15 minutes and will not be shown again.`
        const code = document.createElement('code')
        code.textContent = result.resetCode
        output.append(message, code, button('Copy code', () => { void navigator.clipboard.writeText(result.resetCode) }), button('Close', () => dialog.close()))
        setStatus(`Reset code issued for ${user.username}. Existing sessions revoked.`)
    })
}

function openRoles(user: User): void {
    showDialog(`Roles for ${user.username}`, `<label class="check-label"><input id="role-editor" type="checkbox" ${user.contentEditor ? 'checked' : ''} /> Content editor</label><label class="check-label"><input id="role-users" type="checkbox" ${user.userAdmin ? 'checked' : ''} /> User admin</label>`, 'Save roles', async () => {
        const contentEditor = dialog.querySelector<HTMLInputElement>('#role-editor')!.checked
        const userAdmin = dialog.querySelector<HTMLInputElement>('#role-users')!.checked
        await request(`/admin/users/${user.id}/roles`, 'POST', { contentEditor, userAdmin }, true)
        dialog.close()
        setStatus(`Roles updated for ${user.username}.`)
        await loadUsers()
    })
}

document.querySelector<HTMLFormElement>('#admin-login-form')!.addEventListener('submit', async (event) => {
    event.preventDefault()
    const submit = document.querySelector<HTMLButtonElement>('#admin-login-form button[type="submit"]')!
    if (submit.disabled) return
    submit.disabled = true
    const name = document.querySelector<HTMLInputElement>('#admin-name')!.value
    const password = document.querySelector<HTMLInputElement>('#admin-password')!.value
    const error = document.querySelector<HTMLElement>('#admin-login-error')!
    error.textContent = ''
    try {
        const account = await login(name, password)
        if (!account.superAdmin && !account.contentEditor && !account.userAdmin) {
            await logout()
            error.textContent = 'This account has no admin access.'
            return
        }
        document.querySelector<HTMLInputElement>('#admin-password')!.value = ''
        showWorkspace(account)
    } catch (cause) { error.textContent = errorMessage(cause) }
    finally { submit.disabled = false }
})

document.querySelector('#admin-signout')?.addEventListener('click', async () => {
    await logout().catch(() => undefined)
    workspace.hidden = true
    loginSection.hidden = false
    document.querySelector<HTMLElement>('#admin-signout')!.hidden = true
})

void loadAccount().then((account) => { if (account) showWorkspace(account) })
