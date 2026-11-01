export interface Candidate {
    name: string
    spoken: string
    canFly: boolean
    explanation?: string
}

export interface HighScore {
    score: number
    time: number
    player: string
}
