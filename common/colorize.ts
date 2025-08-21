import chalk from 'chalk'

/**
 * Utility for colorizing console output.
 *
 * This utility provides a set of functions to easily apply colors and styles to console output,
 * making it more readable and visually appealing.
 */
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
