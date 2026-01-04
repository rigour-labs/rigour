import { Failure, Gates } from '../../types/index.js';

export interface ASTHandlerContext {
    cwd: string;
    file: string;
    content: string;
}

export abstract class ASTHandler {
    constructor(protected config: Gates) { }
    abstract supports(file: string): boolean;
    abstract run(context: ASTHandlerContext): Promise<Failure[]>;
}
