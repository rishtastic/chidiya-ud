import './style.css'
import Game from './game/game.ts'

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
<div id="game">
    <div id="starter">Click anywhere to begin</div>
    <div id="playerInput"></div>
    <div id="play"></div>
    <div id="scoreboard"></div>
</div>
`

const starter = document.getElementById("starter")

window.ontouchend = () => {
    starter?.remove()
    Game(document.querySelector<HTMLDivElement>("#game"), true)
    window.ontouchend = null
    window.onmouseup = null
}

window.onmouseup = () => {
    starter?.remove()
    Game(document.querySelector<HTMLDivElement>("#game"), false)
    window.ontouchend = null
    window.onmouseup = null
}

