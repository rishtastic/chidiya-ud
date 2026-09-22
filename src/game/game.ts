import objects from './items/standard'
import type { Candidate, HighScore } from './types'
import { bolo, selectRandom } from './utils'

const responseTime = 2000
const scoreStorageKey = 'scores'
const nameLimit = 24

type ScreenState = 'ready' | 'playing' | 'result'
type EndReason = 'released-too-early' | 'held-too-long'

function Game(game: HTMLDivElement | null) {
    if (!game) {
        console.error('Game not initialised')
        return
    }

    const content = game.querySelector<HTMLDivElement>('#game-content')
    const scoreboard = document.querySelector<HTMLElement>('#scoreboard')
    if (!content || !scoreboard) {
        console.error('Game elements not initialised')
        return
    }

    const readyMarkup = content.innerHTML

    let state: ScreenState = 'ready'
    let playerName = ''
    let currentObject = selectRandom(objects)
    let score = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let holding = false
    let activePointerId: number | null = null

    const escapeHtml = (value: string) => value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;')

    const clearTimer = () => {
        if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
        }
    }

    const getScores = (): HighScore[] => {
        try {
            const stored = JSON.parse(localStorage.getItem(scoreStorageKey) ?? '[]')
            if (!Array.isArray(stored)) {
                return []
            }
            return stored.filter((entry): entry is HighScore => (
                typeof entry?.player === 'string'
                && typeof entry?.score === 'number'
                && typeof entry?.time === 'number'
                && entry.player.trim() !== ''
                && entry.score > 0
            ))
        } catch {
            return []
        }
    }

    const saveScore = () => {
        if (score <= 0) {
            return
        }
        const nextScores = [...getScores(), { player: playerName, score, time: Date.now() }]
            .sort((left, right) => right.score - left.score || left.time - right.time)
            .slice(0, 10)
        localStorage.setItem(scoreStorageKey, JSON.stringify(nextScores))
    }

    const renderScores = () => {
        const scores = getScores()
        scoreboard.replaceChildren()

        const title = document.createElement('h2')
        title.id = 'scores-title'
        title.textContent = 'High scores'
        scoreboard.append(title)

        if (scores.length === 0) {
            const empty = document.createElement('p')
            empty.className = 'scores-empty'
            empty.textContent = 'No scores yet. Be the first to play.'
            scoreboard.append(empty)
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
        scoreboard.append(list)
    }

    const renderReady = () => {
        state = 'ready'
        holding = false
        clearTimer()
        game.dataset.state = state
        content.innerHTML = readyMarkup

        const form = content.querySelector<HTMLFormElement>('#player-form')
        const input = content.querySelector<HTMLInputElement>('#player')
        const error = content.querySelector<HTMLElement>('#name-error')
        if (!form || !input || !error) {
            return
        }

        form.addEventListener('submit', (event) => {
            event.preventDefault()
            const name = input.value.trim().slice(0, nameLimit)
            if (!name) {
                error.textContent = 'Please enter your name to play.'
                input.focus()
                return
            }
            playerName = name
            score = 0
            currentObject = selectRandom(objects)
            renderPlaying('Place your finger on the table to begin')
        })

        input.addEventListener('input', () => {
            error.textContent = ''
        })
    }

    const updateScore = () => {
        const scoreValue = content.querySelector<HTMLElement>('#score-value')
        if (scoreValue) {
            scoreValue.textContent = String(score).padStart(2, '0')
        }
    }

    const updatePrompt = (text: string, isGuidance = false) => {
        const prompt = content.querySelector<HTMLElement>('#game-prompt')
        if (!prompt) {
            return
        }
        prompt.textContent = text
        prompt.classList.toggle('game-prompt-guidance', isGuidance)
    }

    const announce = (text: string) => {
        const announcement = content.querySelector<HTMLElement>('#game-announcement')
        if (!announcement) {
            return
        }
        announcement.textContent = ''
        requestAnimationFrame(() => {
            announcement.textContent = text
        })
    }

    const setHoldingAppearance = (isHolding: boolean) => {
        const table = content.querySelector<HTMLButtonElement>('#table-control')
        table?.classList.toggle('is-held', isHolding)
        table?.setAttribute(
            'aria-label',
            isHolding ? 'Finger on table. Release when the item can fly.' : 'Place and keep your finger on the table',
        )
    }

    const showCurrentObject = () => {
        updatePrompt(currentObject.name)
        announce(`${currentObject.name}. Lift if it can fly. Score ${score}.`)
        bolo(`${currentObject.spoken} उड़`)
    }

    const awardPoint = () => {
        score += 1
        updateScore()
    }

    const renderResult = (reason: EndReason, object: Candidate) => {
        state = 'result'
        holding = false
        activePointerId = null
        clearTimer()
        setHoldingAppearance(false)
        saveScore()
        renderScores()
        game.dataset.state = state

        const message = reason === 'released-too-early'
            ? `Oops - ${escapeHtml(object.name)} cannot fly.`
            : `Too late - ${escapeHtml(object.name)} can fly.`

        content.innerHTML = `
          <div class="result-content" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">
            <p class="result-message">${message}</p>
            <p class="result-score">You scored <strong>${score}</strong></p>
            <div class="result-actions">
              <button id="play-again" class="start-button" type="button">Play again</button>
              <button id="change-player" class="text-button" type="button">Change player</button>
            </div>
          </div>
        `

        content.querySelector<HTMLButtonElement>('#play-again')?.addEventListener('click', () => {
            score = 0
            currentObject = selectRandom(objects)
            renderPlaying('Place your finger on the table to begin')
        })
        content.querySelector<HTMLButtonElement>('#change-player')?.addEventListener('click', renderReady)
        content.querySelector<HTMLElement>('.result-content')?.focus()
    }

    const resolveHold = () => {
        if (!holding || state !== 'playing') {
            return
        }
        if (currentObject.canFly) {
            renderResult('held-too-long', currentObject)
            return
        }
        awardPoint()
        currentObject = selectRandom(objects)
        showCurrentObject()
        timer = setTimeout(resolveHold, responseTime)
    }

    const startHold = () => {
        if (state !== 'playing' || holding) {
            return
        }
        holding = true
        setHoldingAppearance(true)
        showCurrentObject()
        timer = setTimeout(resolveHold, responseTime)
    }

    const releaseHold = () => {
        if (state !== 'playing' || !holding) {
            return
        }
        holding = false
        activePointerId = null
        clearTimer()
        setHoldingAppearance(false)

        if (!currentObject.canFly) {
            renderResult('released-too-early', currentObject)
            return
        }

        awardPoint()
        currentObject = selectRandom(objects)
        updatePrompt('Good catch. Place your finger for the next item', true)
        announce(`Good catch. Score ${score}. Place your finger on the table for the next item.`)
    }

    const cancelHold = () => {
        if (!holding) {
            return
        }
        holding = false
        activePointerId = null
        clearTimer()
        setHoldingAppearance(false)
        updatePrompt('Place your finger on the table when you are ready', true)
        announce('Place your finger on the table when you are ready.')
    }

    const renderPlaying = (prompt: string) => {
        state = 'playing'
        game.dataset.state = state
        content.innerHTML = `
          <div class="play-content">
            <div class="game-status" aria-label="Current game status">
              <p>Player <strong>${escapeHtml(playerName)}</strong></p>
              <p>Score <strong id="score-value">00</strong></p>
            </div>
            <div class="prompt-wrap">
              <p id="game-prompt" class="game-prompt game-prompt-guidance" aria-hidden="true">${prompt}</p>
              <p class="prompt-helper">Lift if it can fly</p>
            </div>
            <button id="table-control" class="table-control" type="button" aria-label="Place and keep your finger on the table" aria-describedby="table-helper keyboard-help">
              <span class="tabletop">Place finger</span>
              <span class="table-leg table-leg-left" aria-hidden="true"></span>
              <span class="table-leg table-leg-right" aria-hidden="true"></span>
            </button>
            <p id="table-helper" class="table-helper">Place your finger on the table, or keep Space or Enter pressed</p>
            <p id="keyboard-help" class="sr-only">Keep Space or Enter pressed to keep your finger on the table. Release the key when the item can fly.</p>
            <p id="game-announcement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p>
          </div>
        `

        const table = content.querySelector<HTMLButtonElement>('#table-control')
        if (!table) {
            return
        }

        table.addEventListener('pointerdown', (event) => {
            event.preventDefault()
            activePointerId = event.pointerId
            table.setPointerCapture(event.pointerId)
            startHold()
        })
        table.addEventListener('pointerup', (event) => {
            if (activePointerId === null || activePointerId === event.pointerId) {
                releaseHold()
            }
        })
        table.addEventListener('pointercancel', cancelHold)
        table.addEventListener('lostpointercapture', () => {
            if (holding) {
                cancelHold()
            }
        })
        table.addEventListener('keydown', (event) => {
            if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
                event.preventDefault()
                startHold()
            }
        })
        table.addEventListener('keyup', (event) => {
            if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault()
                releaseHold()
            }
        })
        table.focus()
        announce(prompt)
    }

    window.addEventListener('blur', cancelHold)
    renderScores()
    renderReady()
}

export default Game
