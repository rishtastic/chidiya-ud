export interface Candidate {
    name: string
    spoken: string
    callSuffix: string
    canFly: boolean
}

export interface HighScore {
    score: number
    time: number
    player: string
}
