import '../style.css'
import './site.css'
import { request } from './api'

interface ScoreRow { rank: number; player: string; score: number }
interface ScorePage { scores: ScoreRow[]; page: number; pageSize: number; total: number }

const form = document.querySelector<HTMLFormElement>('#board-search')!
const input = document.querySelector<HTMLInputElement>('#search-name')!
const rows = document.querySelector<HTMLTableSectionElement>('#board-rows')!
const status = document.querySelector<HTMLElement>('#board-status')!
const pageLabel = document.querySelector<HTMLElement>('#board-page')!
const previous = document.querySelector<HTMLButtonElement>('#board-previous')!
const next = document.querySelector<HTMLButtonElement>('#board-next')!
const initial = new URLSearchParams(location.search)
input.value = initial.get('search') ?? ''
let page = Math.max(1, Number(initial.get('page')) || 1)

async function load(): Promise<void> {
    const search = input.value.trim()
    const params = new URLSearchParams({ search, page: String(page) })
    history.replaceState(null, '', `${location.pathname}?${params}`)
    status.textContent = 'Loading scores…'
    try {
        const result = await request<ScorePage>(`/scores/all?${params}`)
        rows.replaceChildren()
        for (const score of result.scores) {
            const row = rows.insertRow()
            const rank = row.insertCell()
            const name = row.insertCell()
            const value = row.insertCell()
            rank.textContent = `#${score.rank}`
            name.textContent = score.player
            value.textContent = String(score.score)
        }
        status.textContent = result.total === 0 ? (search ? 'No scores match that name.' : 'No scores yet.') : `${result.total} scores`
        pageLabel.textContent = `Page ${page} of ${Math.max(1, Math.ceil(result.total / result.pageSize))}`
        previous.disabled = page === 1
        next.disabled = page * result.pageSize >= result.total
    } catch (cause) {
        status.textContent = cause instanceof Error ? cause.message : 'Could not load scores.'
        rows.replaceChildren()
        previous.disabled = true
        next.disabled = true
    }
}

form.addEventListener('submit', (event) => { event.preventDefault(); page = 1; void load() })
previous.addEventListener('click', () => { page -= 1; void load() })
next.addEventListener('click', () => { page += 1; void load() })
void load()
