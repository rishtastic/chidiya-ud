import objects from './items/standard'
import GlobalLeaderboard, { type ScoreSubmission } from './global-leaderboard'
import type { Candidate } from './types'
import { bolo, selectRandom } from './utils'

const initialResponseTime = 2000
const minimumResponseTime = 1000
const responseTimeStep = 50
const nameLimit = 24
const minimumRankLoadingMs = 1800

type ScreenState = 'ready' | 'playing' | 'result'
type EndReason = 'released-too-early' | 'held-too-long'
type DisplayRankRow = { rank: number, score: number, player: string, isPlayer?: boolean }

function Game(game: HTMLDivElement | null, globalLeaderboard?: GlobalLeaderboard) {
    if (!game) {
        console.error('Game not initialised')
        return
    }

    const content = game.querySelector<HTMLDivElement>('#game-content')
    if (!content) {
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
    let roundStartedAt = 0
    let rankLoaderStartedAt = 0
    let leaderboardSession: Promise<string | null> | undefined

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
            startLeaderboardRound()
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

    const currentResponseTime = () => Math.max(
        minimumResponseTime,
        initialResponseTime - score * responseTimeStep,
    )

    const currentSpeechRate = () => 1 + (
        (initialResponseTime - currentResponseTime()) / (initialResponseTime - minimumResponseTime)
    ) * 0.75

    const updatePrompt = (text: string, isGuidance = false) => {
        const prompt = content.querySelector<HTMLElement>('#game-prompt')
        if (!prompt) {
            return
        }
        prompt.textContent = text
        prompt.classList.toggle('game-prompt-guidance', isGuidance)
        prompt.style.fontSize = ''

        if (!isGuidance) {
            requestAnimationFrame(() => fitPromptToWords(prompt, text))
        }
    }

    const fitPromptToWords = (prompt: HTMLElement, text: string) => {
        const longestWord = text.split(/\s+/).reduce((longest, word) => word.length > longest.length ? word : longest, '')
        const availableWidth = prompt.parentElement?.clientWidth ?? prompt.clientWidth
        if (!longestWord || availableWidth === 0) {
            return
        }

        const style = getComputedStyle(prompt)
        const canvas = document.createElement('canvas')
        const context = canvas.getContext('2d')
        if (!context) {
            return
        }
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        const wordWidth = context.measureText(longestWord).width
        if (wordWidth > availableWidth) {
            const fontSize = Math.max(24, Math.floor(Number.parseFloat(style.fontSize) * ((availableWidth - 8) / wordWidth)))
            prompt.style.fontSize = `${fontSize}px`
        }
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
        bolo(`${currentObject.spoken} उड़`, currentSpeechRate())
    }

    const awardPoint = () => {
        score += 1
        updateScore()
    }

    const startLeaderboardRound = () => {
        roundStartedAt = performance.now()
        leaderboardSession = globalLeaderboard?.startSession(playerName)
    }

    const submitGlobalScore = () => {
        const session = leaderboardSession
        const durationMs = Math.round(performance.now() - roundStartedAt)
        if (!globalLeaderboard || !session || score <= 0) {
            return
        }
        void session
            .then((sessionID) => sessionID ? globalLeaderboard.submitScore(sessionID, score, durationMs) : null)
            .then(async (submission) => {
                const remainingLoaderTime = minimumRankLoadingMs - (performance.now() - rankLoaderStartedAt)
                if (remainingLoaderTime > 0) {
                    await new Promise<void>((resolve) => window.setTimeout(resolve, remainingLoaderTime))
                }
                if (submission) {
                    renderGlobalRank(submission)
                    return globalLeaderboard.refresh()
                }
                renderGlobalRankUnavailable()
                return undefined
            })
    }

    const renderGlobalRank = (submission: ScoreSubmission) => {
        const rank = content.querySelector<HTMLElement>('#global-rank')
        const playerRow = rank?.querySelector<HTMLParagraphElement>('.rank-loader-player')
        const slots = rank ? Array.from(rank.querySelectorAll<HTMLParagraphElement>('.rank-loader-slot')) : []
        if (!rank || !playerRow || slots.length !== 3) {
            return
        }
        rank.querySelector('.sr-only')?.remove()

        const player = { rank: submission.rank, score, player: playerName, isPlayer: true }
        const rows: Array<DisplayRankRow | undefined> = submission.rank === 1
            ? [player, submission.below, submission.belowNext]
            : !submission.below
                ? [submission.aboveNext, submission.above, player]
                : [submission.above, player, submission.below]
        const playerIndex = rows.findIndex((row) => row?.isPlayer)
        const rowStep = slots[1].offsetTop - slots[0].offsetTop
        const currentY = rowStep
        rank.classList.remove('is-loading')
        populateRankRow(playerRow, player, true)

        rows.forEach((row, index) => {
            const slot = slots[index]
            if (row?.isPlayer) {
                slot.hidden = true
                return
            }
            if (row) {
                populateRankRow(slot, row)
            } else {
                slot.hidden = true
            }
        })

        const destinationY = playerIndex * rowStep
        const finish = () => {
            playerRow.style.transform = `translateY(${destinationY}px)`
            playerRow.classList.add('is-resolved')
            if (submission.isUniqueLeader) {
                celebrateNewLeader()
            }
        }
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            finish()
            return
        }
        const settle = playerRow.animate([
            { transform: `translateY(${currentY}px)` },
            { transform: `translateY(${destinationY}px)` },
        ], { duration: 550, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
        void settle.finished.then(() => {
            finish()
            settle.cancel()
        }).catch(() => undefined)
    }

    const renderGlobalRankUnavailable = () => {
        const rank = content.querySelector<HTMLElement>('#global-rank')
        if (rank) {
            rank.classList.remove('is-loading')
            rank.textContent = 'Your global rank could not be loaded.'
        }
    }

    const renderGlobalRankLoading = () => {
        const rank = content.querySelector<HTMLElement>('#global-rank')
        if (!rank) {
            return
        }
        rankLoaderStartedAt = performance.now()
        rank.replaceChildren()
        rank.classList.add('is-loading')
        const firstSlot = rankSkeleton()
        const secondSlot = rankSkeleton()
        const thirdSlot = rankSkeleton()
        firstSlot.classList.add('rank-loader-slot')
        secondSlot.classList.add('rank-loader-slot')
        thirdSlot.classList.add('rank-loader-slot')
        const player = rankRow({ rank: '', score, player: playerName }, true)
        player.classList.add('rank-loader-player')
        const announcement = document.createElement('span')
        announcement.className = 'sr-only'
        announcement.textContent = 'Calculating your global rank.'
        rank.append(firstSlot, secondSlot, thirdSlot, player, announcement)
        const rowStep = secondSlot.offsetTop - firstSlot.offsetTop
        player.style.transform = `translateY(${rowStep}px)`
    }

    const rankSkeleton = () => {
        const row = document.createElement('p')
        row.className = 'global-rank-row rank-skeleton'
        for (let index = 0; index < 3; index += 1) {
            row.append(document.createElement('span'))
        }
        return row
    }

    const rankRow = (entry: { rank: number | '', score: number, player: string }, isPlayer = false) => {
        const row = document.createElement('p')
        populateRankRow(row, entry, isPlayer)
        return row
    }

    const populateRankRow = (row: HTMLParagraphElement, entry: { rank: number | '', score: number, player: string }, isPlayer = false) => {
        const isLoaderSlot = row.classList.contains('rank-loader-slot')
        const isLoaderPlayer = row.classList.contains('rank-loader-player')
        row.className = 'global-rank-row'
        row.classList.toggle('rank-loader-slot', isLoaderSlot)
        row.classList.toggle('rank-loader-player', isLoaderPlayer)
        row.classList.toggle('is-player', isPlayer)
        const rankValue = document.createElement('span')
        const scoreValue = document.createElement('strong')
        const player = document.createElement('span')
        rankValue.textContent = entry.rank === '' ? '' : `#${entry.rank}`
        scoreValue.textContent = String(entry.score)
        player.textContent = entry.player
        row.replaceChildren(rankValue, scoreValue, player)
    }

    const celebrateNewLeader = () => {
        const result = content.querySelector<HTMLElement>('.result-content')
        if (!result || result.querySelector('.confetti')) {
            return
        }
        const confetti = document.createElement('div')
        confetti.className = 'confetti'
        confetti.setAttribute('aria-hidden', 'true')
        const colors = ['#b9553b', '#d6a12a', '#52734d', '#243b67']
        for (let index = 0; index < 28; index += 1) {
            const piece = document.createElement('span')
            piece.style.setProperty('--x', `${Math.round(Math.random() * 100)}%`)
            piece.style.setProperty('--delay', `${Math.round(Math.random() * 180)}ms`)
            piece.style.setProperty('--color', colors[index % colors.length])
            piece.style.setProperty('--turn', `${Math.round((Math.random() - 0.5) * 540)}deg`)
            confetti.append(piece)
        }
        result.append(confetti)
    }

    const renderResult = (reason: EndReason, object: Candidate) => {
        state = 'result'
        holding = false
        activePointerId = null
        clearTimer()
        setHoldingAppearance(false)
        submitGlobalScore()
        game.dataset.state = state

        const message = reason === 'released-too-early'
            ? `Oops - ${escapeHtml(object.name)} cannot fly.`
            : `Too late - ${escapeHtml(object.name)} can fly.`

        content.innerHTML = `
          <div class="result-content" role="status" aria-live="polite" aria-atomic="true" tabindex="-1">
            <p class="result-message">${message}</p>
            <p class="result-score">You scored <strong>${score}</strong></p>
            <div id="global-rank" class="global-rank" role="status" aria-live="polite" aria-atomic="true">${score > 0 ? '' : 'Score a point to earn a global rank.'}</div>
            <div class="result-actions">
              <button id="play-again" class="start-button" type="button">Play again</button>
              <button id="change-player" class="text-button" type="button">Change player</button>
            </div>
          </div>
        `

        if (score > 0) {
            renderGlobalRankLoading()
        }

        content.querySelector<HTMLButtonElement>('#play-again')?.addEventListener('click', () => {
            score = 0
            currentObject = selectRandom(objects)
            startLeaderboardRound()
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
        timer = setTimeout(resolveHold, currentResponseTime())
    }

    const startHold = () => {
        if (state !== 'playing' || holding) {
            return
        }
        holding = true
        setHoldingAppearance(true)
        showCurrentObject()
        timer = setTimeout(resolveHold, currentResponseTime())
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
        table.focus({ preventScroll: true })
        window.scrollTo({ top: 0, behavior: 'smooth' })
        announce(prompt)
    }

    window.addEventListener('blur', cancelHold)
    document.addEventListener('keydown', (event) => {
        if (state === 'playing' && (event.key === ' ' || event.key === 'Enter')) {
            event.preventDefault()
            startHold()
        }
        if (state === 'result' && event.key === ' ' && !(event.target instanceof HTMLButtonElement)) {
            event.preventDefault()
        }
    })
    document.addEventListener('keyup', (event) => {
        if (state === 'playing' && (event.key === ' ' || event.key === 'Enter')) {
            event.preventDefault()
            releaseHold()
        }
    })
    renderReady()
}

export default Game
