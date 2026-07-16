export interface Tokenizer {
    encode(text: string): Int32Array;
}
export declare function loadTokenizer(tokenizerJsonPath: string): Promise<Tokenizer>;
