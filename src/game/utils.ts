export function selectRandom<Type>(arr: Type[]): Type {
    const random = Math.floor(Math.random() * arr.length);
    return arr[random]
}

export function bolo(term: string, rate = 1) {
    speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(term);
    utterance.lang = "hi-IN";
    utterance.rate = rate;
    speechSynthesis.speak(utterance);
}
