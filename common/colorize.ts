import chalk from 'chalk'

export const colorize = {
    error: chalk.red.bold,
    success: chalk.green.bold,
    warning: chalk.yellow.bold,
    info: chalk.blue,
    debug: chalk.bgBlue.yellow.bold,
    tcp: chalk.cyan,
    client: chalk.magenta,
    server: chalk.green.bold,
    data: chalk.yellow,
}
