export declare function embeddedNames(pageSource: string): string[];
export declare function missingFromBundle(names: string[], bundle: string): string[];
export declare function extractScript(html: string): string;
export declare function scriptDeclarationProblems(names: string[], scriptText: string): string[];
export declare function renderedPageScript(distFile: string, opts?: { timeoutMs?: number }): Promise<string>;
