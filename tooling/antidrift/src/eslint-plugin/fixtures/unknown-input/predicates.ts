interface Message {
  title: string;
}

export declare function isMessage(input: unknown): input is Message;
export declare function assertMessage(input: unknown): asserts input is Message;
export declare function looksValid(input: unknown): boolean;
