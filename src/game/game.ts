import { itemLists } from './items/lists'
import type { Leaderboard, ScoreSubmission } from './global-leaderboard'
import type { Candidate } from './types'
import { bolo, selectRandom } from './utils'
import { currentAccount, endGuestSession, loadPublishedItems, login } from '../site/api'

const initialResponseTime = 2000
const minimumResponseTime = 1000
const responseTimeStep = 50
const nameLimit = 24
const minimumRankLoadingMs = 1800
const websiteMode = import.meta.env.MODE !== 'pages'

type ScreenState = 'ready' | 'playing' | 'result'
type EndReason = 'released-too-early' | 'held-too-long'
type DisplayRankRow = { rank: number, score: number, player: string, isPlayer?: boolean }
function Game(game: HTMLDivElement | null, globalLeaderboard?: Leaderboard) {
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
    let playerPassword = ''
    let itemPool: Candidate[] = []
    let selectedLanguages: Array<keyof typeof itemLists> = []
    let guestRound = false
    let guestPromptShown = false
    let currentObject: Candidate
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

    const prepareItemPool = async () => {
        const lists = websiteMode ? await loadPublishedItems() : itemLists
        itemPool = selectedLanguages.flatMap((language) => lists[language])
        if (itemPool.length === 0) throw new Error('No published items are available for those languages.')
    }

    const revealSavePrompt = () => {
        content.querySelector<HTMLElement>('#save-name-prompt')?.removeAttribute('hidden')
    }

    const renderReady = () => {
        state = 'ready'
        playerPassword = ''
        holding = false
        clearTimer()
        game.dataset.state = state
        content.innerHTML = readyMarkup

        const form = content.querySelector<HTMLFormElement>('#player-form')
        const input = content.querySelector<HTMLInputElement>('#player')
        const error = content.querySelector<HTMLElement>('#name-error')
        const password = content.querySelector<HTMLInputElement>('#player-password')
        const passwordLabel = content.querySelector<HTMLLabelElement>('#player-password-label')
        const startButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]')
        if (!form || !input || !error || !password || !passwordLabel || !startButton) {
            return
        }

        if (websiteMode && currentAccount()) input.value = currentAccount()!.username

        let nameCheckTimer: ReturnType<typeof setTimeout> | undefined
        let nameCheckVersion = 0
        let checkedName = ''
        let passwordRequired = false

        const showPassword = (visible: boolean) => {
            password.hidden = !visible
            passwordLabel.hidden = !visible
            if (!visible) password.value = ''
        }

        const checkName = async (name: string, version: number) => {
            const required = await globalLeaderboard?.requiresPassword(name)
            if (version !== nameCheckVersion || state !== 'ready' || input.value.trim().slice(0, nameLimit) !== name) {
                return null
            }
            if (required !== null && required !== undefined) {
                checkedName = name
                passwordRequired = required
                showPassword(required)
            }
            return required ?? null
        }

        showPassword(false)

        form.addEventListener('submit', async (event) => {
            event.preventDefault()
            if (startButton.disabled) return
            const name = input.value.trim().slice(0, nameLimit)
            if (!name) {
                error.textContent = 'Please enter your name to play.'
                input.focus()
                return
            }
            selectedLanguages = new FormData(form).getAll('language')
                .filter((value): value is keyof typeof itemLists => typeof value === 'string' && Object.hasOwn(itemLists, value))
            if (selectedLanguages.length === 0) {
                error.textContent = 'Choose at least one item language.'
                return
            }
            let authenticatedSession: Promise<string | null> | undefined
            if (websiteMode) {
                startButton.disabled = true
                if (nameCheckTimer) clearTimeout(nameCheckTimer)
                const version = ++nameCheckVersion
                const required = checkedName === name ? passwordRequired : await checkName(name, version)
                if (required === null || required === undefined) {
                    startButton.disabled = false
                    error.textContent = 'Could not check this name. Try again.'
                    return
                }
                if (required && !password.value) {
                    startButton.disabled = false
                    error.textContent = 'Enter the password for this name.'
                    password.focus()
                    return
                }
                input.disabled = true
                password.disabled = true
                try {
                    await prepareItemPool()
                    if (required) {
                        await login(name, password.value)
                        password.value = ''
                        document.dispatchEvent(new Event('chidiya:session-change'))
                    }
                } catch (cause) {
                    error.textContent = cause instanceof Error ? cause.message : 'Could not load items. Try again.'
                    startButton.disabled = false
                    input.disabled = false
                    password.disabled = false
                    return
                }
                const sessionID = await globalLeaderboard?.startSession(name)
                startButton.disabled = false
                input.disabled = false
                password.disabled = false
                if (!sessionID) {
                    error.textContent = globalLeaderboard?.getLastError?.() ?? 'Could not start the game.'
                    if (required) password.focus()
                    return
                }
                playerPassword = ''
                authenticatedSession = Promise.resolve(sessionID)
            } else {
                await prepareItemPool()
            }
            playerName = name
            guestRound = websiteMode && !passwordRequired && currentAccount()?.username.toLowerCase() !== name.toLowerCase()
            score = 0
            currentObject = selectRandom(itemPool)
            startLeaderboardRound(authenticatedSession)
            renderPlaying('Place your finger on the table to begin')
        })

        input.addEventListener('input', () => {
            error.textContent = ''
            if (nameCheckTimer) clearTimeout(nameCheckTimer)
            const version = ++nameCheckVersion
            checkedName = ''
            passwordRequired = false
            showPassword(false)
            const name = input.value.trim().slice(0, nameLimit)
            if (name && import.meta.env.MODE !== 'pages') {
                nameCheckTimer = setTimeout(() => { void checkName(name, version) }, 350)
            }
        })
        password.addEventListener('input', () => {
            error.textContent = ''
        })
        form.querySelectorAll<HTMLInputElement>('input[name="language"]').forEach((language) => {
            language.addEventListener('change', () => {
                error.textContent = ''
            })
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

    const startLeaderboardRound = (session?: Promise<string | null>) => {
        roundStartedAt = performance.now()
        leaderboardSession = session ?? globalLeaderboard?.startSession(playerName, playerPassword || undefined)
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
            }).catch(renderGlobalRankUnavailable)
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
            revealSavePrompt()
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
            rank.textContent = 'Your rank could not be loaded.'
        }
        revealSavePrompt()
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
        announcement.textContent = 'Calculating your rank.'
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
        if (!result || result.querySelector('.confetti') || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return
        }
        const confetti = document.createElement('div')
        confetti.className = 'confetti'
        confetti.setAttribute('aria-hidden', 'true')
        const colors = ['#b9553b', '#d6a12a', '#52734d', '#243b67']
        let piecesRemaining = 28
        confetti.addEventListener('animationend', (event) => {
            if (event.target instanceof HTMLSpanElement && --piecesRemaining === 0) {
                confetti.remove()
            }
        })
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

        const explanation = websiteMode && object.explanation?.trim()
            ? `<p class="result-explanation">${escapeHtml(object.explanation.trim())}</p>`
            : ''
        const savePrompt = guestRound && websiteMode
            ? `<div id="save-name-prompt" class="save-name-prompt${guestPromptShown ? ' is-quiet' : ''}" hidden>${guestPromptShown ? '' : `<p>Keep ${escapeHtml(playerName)} for yourself</p>`}<button id="save-name" class="text-button" type="button">Save my name</button>${guestPromptShown ? '' : '<button id="save-name-later" class="text-button" type="button">Not now</button>'}</div>`
            : ''
        content.innerHTML = `
          <div class="result-content" tabindex="-1">
            <p class="result-message">${message}</p>
            ${explanation}
            <p class="result-score">You scored <strong>${score}</strong></p>
            <div id="global-rank" class="global-rank" role="status" aria-live="polite" aria-atomic="true">${score > 0 ? '' : 'Score a point to earn a rank.'}</div>
            ${savePrompt}
            <div class="result-actions">
              <button id="play-again" class="start-button" type="button">Play again</button>
              <button id="change-player" class="text-button" type="button">Change player</button>
              <p id="replay-error" class="field-error" role="alert"></p>
            </div>
          </div>
        `

        if (score > 0) {
            renderGlobalRankLoading()
        } else {
            revealSavePrompt()
        }

        content.querySelector<HTMLButtonElement>('#save-name')?.addEventListener('click', () => {
            guestPromptShown = true
            document.dispatchEvent(new CustomEvent('chidiya:save-name', { detail: { name: playerName } }))
        })
        content.querySelector<HTMLButtonElement>('#save-name-later')?.addEventListener('click', () => {
            guestPromptShown = true
            content.querySelector<HTMLElement>('#save-name-prompt')?.setAttribute('hidden', '')
        })

        content.querySelector<HTMLButtonElement>('#play-again')?.addEventListener('click', async (event) => {
            let authenticatedSession: Promise<string | null> | undefined
            if (websiteMode) {
                const button = event.currentTarget as HTMLButtonElement
                button.disabled = true
                try {
                    await prepareItemPool()
                } catch (cause) {
                    content.querySelector<HTMLElement>('#replay-error')!.textContent = cause instanceof Error ? cause.message : 'Could not load items.'
                    button.disabled = false
                    return
                }
                const sessionID = await globalLeaderboard?.startSession(playerName, playerPassword || undefined)
                button.disabled = false
                if (!sessionID) {
                    content.querySelector<HTMLElement>('#replay-error')!.textContent = globalLeaderboard?.getLastError?.() ?? 'Could not start another game.'
                    return
                }
                authenticatedSession = Promise.resolve(sessionID)
            }
            score = 0
            guestRound = websiteMode && !playerPassword && playerName.toLowerCase() !== currentAccount()?.username.toLowerCase()
            currentObject = selectRandom(itemPool)
            startLeaderboardRound(authenticatedSession)
            renderPlaying('Place your finger on the table to begin')
        })
        content.querySelector<HTMLButtonElement>('#change-player')?.addEventListener('click', async () => {
            if (websiteMode) await endGuestSession().catch(() => undefined)
            guestPromptShown = false
            renderReady()
        })
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
        currentObject = selectRandom(itemPool)
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
        currentObject = selectRandom(itemPool)
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
    document.addEventListener('chidiya:account-change', () => {
        if (state === 'ready') content.querySelector<HTMLInputElement>('#player')?.dispatchEvent(new Event('input'))
    })
    document.addEventListener('keydown', (event) => {
        if (document.querySelector('dialog[open]') || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return
        if (state === 'playing' && (event.key === ' ' || event.key === 'Enter')) {
            event.preventDefault()
            startHold()
        }
        if (state === 'result' && event.key === ' ' && !(event.target instanceof HTMLButtonElement)) {
            event.preventDefault()
        }
    })
    document.addEventListener('keyup', (event) => {
        if (document.querySelector('dialog[open]') || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return
        if (state === 'playing' && (event.key === ' ' || event.key === 'Enter')) {
            event.preventDefault()
            releaseHold()
        }
    })
    renderReady()
}

export default Game
