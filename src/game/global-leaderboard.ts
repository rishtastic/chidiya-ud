export interface GlobalLeaderboardScore {
    player: string
    score: number
    createdAt: string
}

interface ScoresResponse {
    scores: GlobalLeaderboardScore[]
}

interface SessionResponse {
    sessionId: string
}

export interface ScoreSubmission {
    accepted: boolean
    rank: number
    isUniqueLeader: boolean
    above?: RankedLeaderboardScore
    aboveNext?: RankedLeaderboardScore
    below?: RankedLeaderboardScore
    belowNext?: RankedLeaderboardScore
}

export interface RankedLeaderboardScore {
    player: string
    score: number
    rank: number
}

const apiBase = `${import.meta.env.BASE_URL}api`

export default class GlobalLeaderboard {
    private readonly container: HTMLElement | null

    constructor(container: HTMLElement | null) {
        this.container = container
    }

    async startSession(player: string): Promise<string | null> {
        try {
            const response = await fetch(`${apiBase}/sessions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ player }),
            })
            if (!response.ok) {
                return null
            }
            const data = await response.json() as SessionResponse
            return data.sessionId
        } catch {
            return null
        }
    }

    async submitScore(sessionId: string, score: number, durationMs: number): Promise<ScoreSubmission | null> {
        try {
            const response = await fetch(`${apiBase}/scores`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sessionId, score, durationMs }),
            })
            if (!response.ok) {
                return null
            }
            return await response.json() as ScoreSubmission
        } catch {
            return null
        }
    }

    async refresh(): Promise<void> {
        if (!this.container) {
            return
        }

        try {
            const response = await fetch(`${apiBase}/scores`, { headers: { Accept: 'application/json' } })
            if (!response.ok) {
                throw new Error('Leaderboard unavailable')
            }
            const data = await response.json() as ScoresResponse
            this.renderScores(data.scores)
        } catch {
            this.renderUnavailable()
        }
    }

    private renderScores(scores: GlobalLeaderboardScore[]) {
        if (!this.container) {
            return
        }
        this.container.replaceChildren(this.title())

        if (scores.length === 0) {
            const empty = document.createElement('p')
            empty.className = 'scores-empty'
            empty.textContent = 'No global scores yet. Set the first one.'
            this.container.append(empty)
            return
        }

        const list = document.createElement('ol')
        list.className = 'scores-list'
        scores.forEach((highScore) => {
            const item = document.createElement('li')
            const player = document.createElement('span')
            const value = document.createElement('strong')
            player.textContent = highScore.player
            value.textContent = String(highScore.score)
            item.append(player, value)
            list.append(item)
        })
        this.container.append(list)
    }

    private renderUnavailable() {
        if (!this.container) {
            return
        }
        this.container.replaceChildren(this.title())
        const message = document.createElement('p')
        message.className = 'scores-empty'
        message.textContent = 'Global scores will appear when the leaderboard is available.'
        this.container.append(message)
    }

    private title() {
        const title = document.createElement('h2')
        title.id = 'global-scores-title'
        title.textContent = 'High scores'
        return title
    }
}
