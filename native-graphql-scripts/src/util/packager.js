// @flow

import { PackagerLogsStream, Project, ProjectSettings, ProjectUtils } from 'xdl';

import spawn from 'cross-spawn';
import ProgressBar from 'progress';
import bunyan from '@expo/bunyan';
import chalk from 'chalk';

import log from './log';

function installExitHooks(projectDir, isInteractive) {
  if (!isInteractive && process.platform === 'win32') {
    require('readline')
      .createInterface({
        input: process.stdin,
        output: process.stdout,
      })
      .on('SIGINT', () => {
        process.emit('SIGINT');
      });
  }

  process.on('SIGINT', () => {
    log.withTimestamp('Stopping packager...');
    cleanUpPackager(projectDir).then(() => {
      // TODO: this shows up after process exits, fix it
      log.withTimestamp(chalk.green('Packager stopped.'));
      process.exit();
    });
  });
}

async function cleanUpPackager(projectDir) {
  const result = await Promise.race([
    Project.stopAsync(projectDir),
    new Promise((resolve, reject) => setTimeout(resolve, 1000, 'stopFailed')),
  ]);

  if (result === 'stopFailed') {
    // find RN packager pid, attempt to kill manually
    try {
      const { packagerPid } = await ProjectSettings.readPackagerInfoAsync(projectDir);
      process.kill(packagerPid);
    } catch (e) {
      process.exit(1);
    }
  }
}

function shouldIgnoreMsg(msg) {
  return msg.indexOf('Duplicate module name: bser') >= 0 ||
    msg.indexOf('Duplicate module name: fb-watchman') >= 0 ||
    msg.indexOf('Warning: React.createClass is no longer supported') >= 0 ||
    msg.indexOf('Warning: PropTypes has been moved to a separate package') >= 0;
}

function run(onReady: () => ?any, options: Object = {}, isInteractive = false) {
  let packagerReady = false;
  let needsClear = false;
  let logBuffer = '';
  let progressBar;
  const projectDir = process.cwd();

  if (process.platform !== 'win32') {
    const watchmanExists = spawn.sync('which', ['watchman']).status === 0;

    if (process.platform === 'darwin' && !watchmanExists) {
      const watcherDetails = spawn.sync('sysctl', ['kern.maxfiles']).stdout.toString();
      if (parseInt(watcherDetails.split(':')[1].trim()) < 5242880) {
        log.withTimestamp(
          `${chalk.red(`Unable to start server`)}
See https://git.io/v5vcn for more information, either install watchman or run the following snippet:
${chalk.cyan(`  sudo sysctl -w kern.maxfiles=5242880
  sudo sysctl -w kern.maxfilesperproc=524288`)}
        `
        );
        process.exit(1);
      }
    } else if (!watchmanExists) {
      const watcherDetails = spawn
        .sync('sysctl', ['fs.inotify.max_user_watches'])
        .stdout.toString();
      if (parseInt(watcherDetails.split('=')[1].trim()) < 12288) {
        log.withTimestamp(
          `${chalk.red(`Unable to start server`)}
See https://git.io/v5vcn for more information, either install watchman or run the following snippet:
${chalk.cyan(`  sudo sysctl -w fs.inotify.max_user_instances=1024
  sudo sysctl -w fs.inotify.max_user_watches=12288`)}`
        );
        process.exit(1);
      }
    }
  }

  const handleLogChunk = chunk => {
    // pig, meet lipstick
    // 1. https://github.com/facebook/react-native/issues/14620
    // 2. https://github.com/facebook/react-native/issues/14610
    // 3. https://github.com/luandro/create-native-graphql-app/issues/229#issuecomment-308654303
    // @ide is investigating 3), the first two are upstream issues that will
    // likely be resolved by others
    if (shouldIgnoreMsg(chunk.msg)) {
      return;
    }

    // we don't need to print the entire manifest when loading the app
    if (chunk.msg.indexOf(' with appParams: ') >= 0) {
      if (needsClear) {
        // this is set when we previously encountered an error
        // TODO clearConsole();
      }
      let devEnabled = chunk.msg.includes('__DEV__ === true');
      log.withTimestamp(
        `Running app on ${chunk.deviceName} in ${devEnabled ? 'development' : 'production'} mode\n`
      );
      return;
    }

    if (chunk.msg === 'Dependency graph loaded.') {
      packagerReady = true;
      onReady();
      return;
    }

    if (packagerReady) {
      const message = `${chunk.msg.trim()}\n`;
      if (chunk.level <= bunyan.INFO) {
        log.withTimestamp(message);
      } else if (chunk.level === bunyan.WARN) {
        log.withTimestamp(chalk.yellow(message));
      } else {
        log.withTimestamp(chalk.red(message));

        // if you run into a syntax error then we should clear log output on reload
        needsClear = message.indexOf('SyntaxError') >= 0;
      }
    } else {
      if (chunk.level >= bunyan.ERROR) {
        log(chalk.yellow('***ERROR STARTING PACKAGER***'));
        log(logBuffer);
        log(chalk.red(chunk.msg));
        logBuffer = '';
      } else {
        logBuffer += chunk.msg + '\n';
      }
    }
  };

  // Subscribe to packager/server logs
  let packagerLogsStream = new PackagerLogsStream({
    projectRoot: projectDir,
    onStartBuildBundle: () => {
      progressBar = new ProgressBar('Building JavaScript bundle [:bar] :percent', {
        total: 100,
        clear: true,
        complete: '=',
        incomplete: ' ',
      });

      log.setBundleProgressBar(progressBar);
    },
    onProgressBuildBundle: percent => {
      if (!progressBar || progressBar.complete) return;
      let ticks = percent - progressBar.curr;
      ticks > 0 && progressBar.tick(ticks);
    },
    onFinishBuildBundle: (err, startTime, endTime) => {
      if (progressBar && !progressBar.complete) {
        progressBar.tick(100 - progressBar.curr);
      }

      if (progressBar) {
        log.setBundleProgressBar(null);
        progressBar = null;

        if (err) {
          log.withTimestamp(chalk.red(`Failed building JavaScript bundle`));
        } else {
          let duration = endTime - startTime;
          log.withTimestamp(chalk.green(`Finished building JavaScript bundle in ${duration}ms`));
        }
      }
    },
    updateLogs: updater => {
      let newLogChunks = updater([]);

      if (progressBar) {
        // Restarting watchman causes `onFinishBuildBundle` to not fire. Until
        // this is handled upstream in xdl, reset progress bar with error here.
        newLogChunks.forEach(chunk => {
          if (chunk.msg === 'Restarted watchman.') {
            progressBar.tick(100 - progressBar.curr);
            log.setBundleProgressBar(null);
            progressBar = null;
            log.withTimestamp(chalk.red('Failed building JavaScript bundle'));
          }
        });
      }

      newLogChunks.map(handleLogChunk);
    },
  });

  // Subscribe to device updates separately from packager/server updates
  ProjectUtils.attachLoggerStream(projectDir, {
    stream: {
      write: chunk => {
        if (chunk.tag === 'device') {
          handleLogChunk(chunk);
        }
      },
    },
    type: 'raw',
  });

  installExitHooks(projectDir, isInteractive);
  log.withTimestamp('Starting packager...');

  Project.startAsync(projectDir, options).then(
    () => {},
    reason => {
      log.withTimestamp(chalk.red(`Error starting packager: ${reason.stack}`));
      process.exit(1);
    }
  );
}

export default { run };
