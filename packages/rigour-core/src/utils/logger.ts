import chalk from 'chalk';

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

export class Logger {
    private static level: LogLevel = LogLevel.INFO;

    static setLevel(level: LogLevel) {
        this.level = level;
    }

    static info(message: string) {
        if (this.level <= LogLevel.INFO) {
            console.log(chalk.blue('info: ') + message);
        }
    }

    static warn(message: string) {
        if (this.level <= LogLevel.WARN) {
            console.log(chalk.yellow('warn: ') + message);
        }
    }

    static error(message: string, error?: any) {
        if (this.level <= LogLevel.ERROR) {
            console.error(chalk.red('error: ') + message);
            if (error) {
                console.error(error);
            }
        }
    }

    static debug(message: string) {
        if (this.level <= LogLevel.DEBUG) {
            console.log(chalk.dim('debug: ') + message);
        }
    }
}
