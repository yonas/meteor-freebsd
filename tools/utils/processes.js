var _ = require('underscore');
var child_process = require('child_process');
var Console = require('../console/console.js').Console;

var processes = exports;

var RunCommand = function (command, args, options) {
  var self = this;

  var defaultOptions = {};
  // Make stdin,stdout & stderr pipes (not shared)
  defaultOptions.stdio = ['pipe', 'pipe', 'pipe'];
  defaultOptions.env = process.env;
  defaultOptions.checkExitCode = true;

  options = _.extend(defaultOptions, options);

  self.command = command;
  self.args = args;
  self.options = options;

  self.exitPromise = new Promise(function (resolve, reject) {
    self._exitNormally = resolve;
    self._exitWithError = reject;
  });

  self.exitCode = undefined;

  self.stdout = '';
  self.stderr = '';
};

_.extend(RunCommand.prototype, {
  start: function () {
    var self = this;
    if (self.process) {
      throw new Error("Process already started");
    }
    if (Console.isDebugEnabled()) {
      var envString = '';
      var defaultEnv = process.env;
      if (self.options.env) {
        _.each(self.options.env, function (v,k) {
          var defaultV = defaultEnv[k];
          if (v !== defaultV) {
            envString += k + "=" + v + " ";
          }
        });
      }
      Console.debug("Running command", envString, self.command, self.args.join(' '));
    }

    self.process = child_process.spawn( self.command,
                                        self.args,
                                        self.options);
    self.process.on('close', function (exitCode) {
      self.exitCode = exitCode;

      if (self.options.checkExitCode && exitCode != 0) {
        console.log("Unexpected exit code", exitCode, "from", self.command, self.args, "\nstdout:\n", self.stdout, "\nstderr:\n", self.stderr);
      }

      self._exitNormally(exitCode);
    });

    self.process.on('error', function (err) {
      Console.debug("Error while running command", err);
      self.exitError = err;
      self._exitWithError(err);
    });

    self.process.stdout.on('data', function (data) {
      self.stdout = self.stdout + data;
      if (self.options.pipeOutput) {
        Console.rawInfo(data);
      }
      if (self.options.onStdout) {
        self.options.onStdout(data);
      }
    });

    self.process.stderr.on('data', function (data) {
      self.stderr = self.stderr + data;
      if (self.options.pipeOutput) {
        Console.rawError(data);
      }
      if (self.options.onStderr) {
        self.options.onStderr(data);
      }
    });

    self.stdin = self.process.stdin;

    if (self.options.stdin) {
      self.stdin.write(self.options.stdin);
    }

    if (self.options.detached) {
      self.process.unref();
    }
  },

  waitForExit: function () {
    var self = this;
    return self.exitPromise.await();
  },

  kill: function () {
    var self = this;
    self.process.kill();
  },

  run: function () {
    var self = this;

    self.start();
    if (self.options.detached) {
      Console.debug("run called on detached process; won't wait");
      return undefined;
    }
    self.waitForExit();
    return { stdout: self.stdout, stderr: self.stderr, exitCode: self.exitCode };
  }
});

exports.RunCommand = RunCommand;
