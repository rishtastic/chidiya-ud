import type { HighScore } from './types'
import type { Leaderboard, RankedLeaderboardScore, ScoreSubmission } from './global-leaderboard'

const scoreStorageKey = 'scores'

export default class LocalLeaderboard implements Leaderboard {
    private readonly container: HTMLElement | null

    constructor(container: HTMLElement | null) {
        this.container = container
    }

    async startSession(player: string): Promise<string> {
        return player
    }

    async submitScore(player: string, score: number, _durationMs: number): Promise<ScoreSubmission | null> {
        if (score <= 0) {
            return null
        }

        const previous = this.getScores()
        const current: HighScore = { player, score, time: Date.now() }
        const ranked = [...previous, current]
            .sort((left, right) => right.score - left.score || left.time - right.time)
        const position = ranked.indexOf(current)
        const rowAt = (index: number): RankedLeaderboardScore | undefined => {
            const entry = ranked[index]
            return entry && {
                player: entry.player,
                score: entry.score,
                rank: ranked.findIndex((item) => item.score === entry.score) + 1,
            }
        }

        try {
            localStorage.setItem(scoreStorageKey, JSON.stringify(ranked.slice(0, 10)))
        } catch {
            return null
        }

        return {
            accepted: true,
            rank: ranked.findIndex((entry) => entry.score === score) + 1,
            isUniqueLeader: position === 0 && previous.every((entry) => score > entry.score),
            above: rowAt(position - 1),
            aboveNext: rowAt(position - 2),
            below: rowAt(position + 1),
            belowNext: rowAt(position + 2),
        }
    }

    async refresh(): Promise<void> {
        if (!this.container) {
            return
        }
        const title = document.createElement('h2')
        title.id = 'global-scores-title'
        title.textContent = 'High scores'
        this.container.replaceChildren(title)

        const scores = this.getScores()
        if (scores.length === 0) {
            const empty = document.createElement('p')
            empty.className = 'scores-empty'
            empty.textContent = 'No scores yet. Be the first to play.'
            this.container.append(empty)
            return
        }

        const list = document.createElement('ol')
        list.className = 'scores-list'
        scores.forEach((entry) => {
            const item = document.createElement('li')
            const player = document.createElement('span')
            const value = document.createElement('strong')
            player.textContent = entry.player
            value.textContent = String(entry.score)
            item.append(player, value)
            list.append(item)
        })
        this.container.append(list)
    }

    private getScores(): HighScore[] {
        try {
            const stored: unknown = JSON.parse(localStorage.getItem(scoreStorageKey) ?? '[]')
            if (!Array.isArray(stored)) {
                return []
            }
            return stored.filter((entry): entry is HighScore => (
                typeof entry?.player === 'string'
                && typeof entry?.score === 'number'
                && typeof entry?.time === 'number'
                && entry.player.trim() !== ''
                && entry.score > 0
            )).sort((left, right) => right.score - left.score || left.time - right.time).slice(0, 10)
        } catch {
            return []
        }
    }
}
