import './style.css'
import Game from './game/game.ts'

Game(document.querySelector<HTMLDivElement>('#game'))

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
