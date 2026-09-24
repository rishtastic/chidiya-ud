import './style.css'
import Game from './game/game.ts'
import GlobalLeaderboard from './game/global-leaderboard.ts'
import LocalLeaderboard from './game/local-leaderboard.ts'

const leaderboard = import.meta.env.MODE === 'pages'
    ? new LocalLeaderboard(document.querySelector<HTMLElement>('#global-scoreboard'))
    : new GlobalLeaderboard(document.querySelector<HTMLElement>('#global-scoreboard'))
Game(document.querySelector<HTMLDivElement>('#game'), leaderboard)
void leaderboard.refresh()

const controlsDialog = document.querySelector<HTMLDialogElement>('#controls-dialog')

document.addEventListener('click', (event) => {
    const target = event.target
    if (!(target instanceof Element) || !controlsDialog) {
        return
    }

    if (target.closest('#controls-trigger')) {
        controlsDialog.showModal()
        return
    }

    if (target.closest('#controls-close') || target === controlsDialog) {
        controlsDialog.close()
    }
})
