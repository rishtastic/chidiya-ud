import objects from "./objects"
import type { Candidate, HighScore } from "./types"
import { selectRandom, bolo } from "./utils"

const resTime = 2000;

function Game(game: HTMLDivElement | null, isTouchScreen: boolean) {
    if (!game) {
        console.error("Game not initialised")
        return
    }
    const inputDiv = game.querySelector<HTMLDivElement>("#playerInput")
    if (!inputDiv) {
        console.error("Player input not initialised")
        return
    }
    inputDiv.innerHTML = `
        <input id="player" name="player" placeholder="Enter Player Name" class="player-input-control" />
        <button id="start_btn" type="button" class="player-input-control">Submit</button>
    `
    const playerInput = game.querySelector<HTMLInputElement>("#player")
    const inputBtn = game.querySelector<HTMLButtonElement>("#start_btn")
    if (!playerInput || !inputBtn) {
        console.error("Player input not initialised")
        return
    }
    loadScores(game)
    inputBtn.onclick = () => {
        const name = playerInput.value
        if (!name || name === '') {
            alert("Player name should not be empty")
            return
        }
        PlayGame(game, name, isTouchScreen)
        playerInput.remove()
        inputBtn.remove()
    }
}

function PlayGame(game: HTMLDivElement, playerName: string, isTouchScreen: boolean) {
    const playZone = game.querySelector<HTMLDivElement>("#play")
    if (!playZone) {
        console.error("Elements not initialised")
        return
    }
    const btnText = `Player: ${playerName} | Press Button below to start`
    playZone.innerHTML = `
        <span id="flying">${btnText}</span>
        <button id="chidiya">Click here</button>
        <span id="score">Score: 0</span>
    `
    const flying = game.querySelector<HTMLSpanElement>("#flying")
    const btn = game.querySelector<HTMLButtonElement>("#chidiya")
    const scoring = game.querySelector<HTMLSpanElement>("#score")

    if (!flying || !btn || !scoring) {
        console.error("Elements not initialised")
        return
    }
    bolo(`${playerName} शुरू करते हैं`)
    
    let currObj = objects[0]
    let score = 0
    let timer: number = 0

    const turn = () => {
        score += 1
        updateScore(scoring, score)
        currObj = selectRandom(objects)
    }

    const end = () => {
        flying.innerText = btnText
        saveScore(score, playerName)
        score = 0
        updateScore(scoring, score)
        currObj = selectRandom(objects)
        loadScores(game)
    }

    const gameloop = () => {
        if (currObj.canFly) {
            alert(`${currObj.name} can fly`)
            end()
            clearTimeout(timer)
            return
        }
        turn()
        nextObject(flying, currObj)
        timer = setTimeout(gameloop, resTime)
    }
    
    const down = () => {
        nextObject(flying, currObj)
        timer = setTimeout(gameloop, resTime)
    }
    
    const up = () => {
        clearTimeout(timer)
        if (!currObj.canFly) {
            alert(`${currObj.name} cannot fly`)
            end()
            return
        }
        turn()
    }

    if(isTouchScreen) {
        btn.ontouchstart = down
        btn.ontouchend = up
    } else {
        btn.onmousedown = down
        btn.onmouseup = up
    }
}

const nextObject = (flying: HTMLSpanElement, obj: Candidate): void => {
    flying.innerText = obj.name
    udao(obj.spoken)
}

const updateScore = (scoring: HTMLSpanElement, score: number): void => {
    scoring.innerText = `Score: ${score}`
}

const udao = (name: string) => {
    bolo(`${name} उड़`)
}

const saveScore = (score: number, playerName: string) => {
    if (score <= 0) {
        return
    }
    const highScore: HighScore = {
        score: score,
        time: Date.now(),
        player: playerName
    }
    const scoreJson = localStorage.getItem('scores') ?? '[]'
    const scores: HighScore[] = JSON.parse(scoreJson)
    scores.push(highScore)
    const top = scores
    .filter((a: HighScore) => {
        return a.player !== null && a.player !== undefined && a.player !== 'undefined' && a.player !== ''
    })
    .filter((a: HighScore) => a.score > 0)
    .toSorted((a: HighScore, b: HighScore) => {
        if (a.score == b.score) {
            return a.time - b.time
        }
        return b.score-a.score
    }).slice(0, 10)
    localStorage.setItem('scores', JSON.stringify(top))
}

const loadScores = (game: HTMLDivElement | null) => {
    const scoreboard = game?.querySelector<HTMLDivElement>('#scoreboard')
    if (!scoreboard) {
        return
    }
    scoreboard.innerHTML = `
        <span class="scores-header">High Scores</span>
        <ol></ol>
    `
    const list = scoreboard.querySelector("ol")
    const header = scoreboard.querySelector("span.scores-header")
    if (!header) {
        return
    }
    if (!list) {
        return
    }
    
    const scoreJson = localStorage.getItem('scores') ?? '[]'
    const scores: HighScore[] = JSON.parse(scoreJson)
    if (scores.length <= 0) {
        header.innerHTML = ''
        return
    }
    header.innerHTML = 'High Scores'
    list.innerHTML = ''
    scores.forEach((hs: HighScore) => {
        const li: HTMLLIElement = document.createElement('li')
        const time = new Date(hs.time).toLocaleString()
        li.innerHTML = `${hs.player} | <span class="score-value">${hs.score}</span> | ${time}`
        list.append(li)
    })
}

export default Game
