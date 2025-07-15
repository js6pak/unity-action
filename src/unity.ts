import exec = require('@actions/exec');
import core = require('@actions/core');
import io = require('@actions/io');
import path = require('path');
import fs = require('fs');

const pidFile = path.join(process.env.RUNNER_TEMP, 'unity-process-id.txt');

export async function ExecUnity(editorPath: string, args: string[], tryCount: number = 1): Promise<void> {
    let isCancelled = false;
    const logPath = getLogFilePath(args);

    const cancelListener = async () => {
        await tryKillPid(pidFile);
        isCancelled = true;
    };

    process.once('SIGINT', cancelListener);
    process.once('SIGTERM', cancelListener);

    let exitCode = 0;
    let flaky = false;

    try {
        switch (process.platform) {
            default:
                const unity = path.resolve(__dirname, `unity.ps1`);
                const pwsh = await io.which('pwsh', true);
                let commandLine = `"${pwsh}" -Command ${unity} -EditorPath '${editorPath}' -Arguments '${args.join(` `)}' -LogPath '${logPath}'`;
                if (process.platform === `linux`) {
                    const xvfbRun = await io.which('xvfb-run', true);
                    commandLine = `"${xvfbRun}" ${commandLine}`;
                }
                exitCode = await exec.exec(commandLine, null, {
                    listeners: {
                        stdline: (data) => {
                            const line = data.toString().trim();
                            if (line && line.length > 0) {
                                core.info(line);
                            }
                        },
                        errline: (data) => {
                            const line = data.toString().trim();
                            if (line && line.length > 0) {
                                core.info(line);
                                if (line.includes("Unhandled Exception: System.OverflowException: Number overflow.") ||
                                    line.includes("Unhandled Exception: System.OutOfMemoryException: Out of memory")) {
                                    flaky = true;
                                }
                            }
                        }
                    },
                    silent: true,
                    ignoreReturnCode: true
                });
                break;
        }
    } finally {
        process.removeListener('SIGINT', cancelListener);
        process.removeListener('SIGTERM', cancelListener);
    }

    if (!isCancelled) {
        await tryKillPid(pidFile);

        if (flaky) {
            if (tryCount <= 25) {
                tryCount++;
                core.warning(`Unity crashed in a flaky manner, trying again for the ${tryCount} time`);
                await ExecUnity(editorPath, args, tryCount);
                return;
            } else {
                throw new Error("Unity crashed in a flaky manner too many times");
            }
        }

        if (exitCode !== 0) {
            throw Error(`Unity failed with exit code ${exitCode}`);
        }
    }
}

function getLogFilePath(args: string[]): string {
    const logFileIndex = args.indexOf('-logFile');
    if (logFileIndex === -1) {
        throw Error('Missing -logFile argument');
    }
    return args[logFileIndex + 1];
}

async function tryKillPid(pidFile: string): Promise<void> {
    try {
        const fileHandle = await fs.promises.open(pidFile, 'r');
        try {
            const pid = await fileHandle.readFile('utf8');
            core.debug(`Attempting to kill Unity process with pid: ${pid}`);
            process.kill(parseInt(pid));
        } catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ESRCH') {
                core.error(`Failed to kill Unity process:\n${JSON.stringify(error)}`);
            }
        } finally {
            await fileHandle.close();
            await fs.promises.unlink(pidFile);
        }

    } catch (error) {
        // ignored
    }
}
