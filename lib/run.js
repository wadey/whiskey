/*
 * Licensed to Cloudkick, Inc ('Cloudkick') under one or more
 * contributor license agreements.  See the NOTICE file distributed with
 * this work for additional information regarding copyright ownership.
 * Cloudkick licenses this file to You under the Apache License, Version 2.0
 * (the "License"); you may not use this file except in compliance with
 * the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var fs = require('fs');
var sys = require('sys');
var path = require('path');
var net = require('net');
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;

var sprintf = require('sprintf').sprintf;
var async = require('async');

var constants = require('./constants');
var parser = require('./parser');
var common = require('./common');
var testUtil = require('./util');
var reporters = require('./reporters/index');

var exitCode = 0;

function TestRunner(tests, reporter, coverageReporter, coverage, verbosity) {
  this._tests = tests;
  this._reporter = reporter;
  this._coverageReporter = coverageReporter;
  this._coverage = coverage;
  this._verbosity = verbosity || constants.DEFAULT_VERBOSITY;

  this._server = null;
  this._testFilesData = {};

  this._completed = false;
  this._forceStopped = false;
  this._completedTests = [];
}

TestRunner.prototype.runTests = function(testInitFile, chdir,
                                         customAssertModule,
                                         timeout,
                                         concurrency, failFast) {
  var self = this;
  concurrency = concurrency || constants.DEFAULT_CONCURRENCY;
  timeout = timeout || constants.DEFAULT_TEST_TIMEOUT;

  function handleChildTimeout(child, filePath) {
    var resultObj, testFile;

    if (!child.killed) {
      testFile = self._testFilesData[filePath];

      resultObj = {
        'tests': [],
        'timeout': true
      };

      child.kill('SIGTERM');
      self._handleTestResult(filePath, resultObj);
    }
  }

  function onBound() {
    self._reporter.handleTestsStart();

    async.forEachSeries(self._tests, function(filePath, callback) {
      var cwd, child, timeoutId, testFileData;

      if (self._completed || self._forceStopped) {
        callback(new Error('Runner has been stopped'));
        return;
      }

      cwd = process.cwd();
      filePath = (filePath.charAt(0) !== '/') ? path.join(cwd, filePath) : filePath;
      child = self._spawnTestProcess(filePath, testInitFile, chdir,
                                     customAssertModule,
                                   timeout, concurrency);
      timeoutId = setTimeout(function() {
        handleChildTimeout(child, filePath, callback);
       }, timeout);

      self._testFilesData[filePath] = {
        'child': child,
        'callback': callback,
        'timeout_id': timeoutId
      };

      testFileData = self._testFilesData[filePath];

      child.stdout.on('data', function(chunk) {
        testFileData['stdout'] += chunk;
      });

      child.stderr.on('data', function(chunk) {
        testFileData['stderr'] += chunk;
      });

      child.on('exit', function() {
        clearTimeout(timeoutId);
        self._handleTestFileEnd(filePath);
        delete self._testFilesData[filePath];
      });
    },

    function(err) {
      self._handleTestsCompleted();
    });
  }

  this._startServer(null, async.apply(this._handleConnection, this),
                    onBound);
};

TestRunner.prototype._spawnTestProcess = function(filePath, testInitFile,
                                                  chdir,
                                                  customAssertModule,
                                                  timeout,
                                                  concurrency) {
  var self = this;
  var cwd = process.cwd();
  var libCovDir = (this._coverage) ? path.join(cwd, 'lib-cov') : null;
  var runFilePath = path.join(__dirname, 'run_test_file');

  var args = [runFilePath, filePath, cwd, libCovDir, chdir, customAssertModule,
              testInitFile, timeout, concurrency];

  this._reporter.handleTestFileStart(filePath);
  var child = spawn(process.execPath, args);
  return child;
};

TestRunner.prototype._addCompletedTest = function(filePath) {
  this._completedTests.push(filePath);
};

TestRunner.prototype._handleTestsCompleted = function() {
  var statusCode;

  if (!this._completed || this._forceStopped) {
    this._completed = true;
    this._stopServer();

    statusCode = this._reporter.handleTestsComplete();

    if (this._coverage) {
      this._coverageReporter.handleTestsComplete();
    }

    exitCode = statusCode;
  }
};

TestRunner.prototype._handleTestResult = function(filePath, resultObj) {
  this._reporter.handleTestEnd(filePath, resultObj);
};

TestRunner.prototype._handleTestCoverageResult = function(filePath, coverageData) {
  var coverageObj = JSON.parse(coverageData);
  this._coverageReporter.handleTestFileComplete(filePath, coverageObj);
};

TestRunner.prototype._handleTestFileEnd = function(filePath) {
  var testData, coverageData, resultObj, coverageObj, split, testFile;
  var stdout = '';
  var stderr = '';

  testFile = this._testFilesData[filePath];
  if (testFile) {
    stdout = testFile['stdout'];
    stderr = testFile['stderr'];
  }

  this._reporter.handleTestFileComplete(filePath, stdout, stderr);
  this._addCompletedTest(filePath);

  if (testFile) {
    testFile['callback']();
  }
};

TestRunner.prototype._handleConnection = function(runner, connection) {
  var self = runner;
  var data = '';
  var lineProcessor = new testUtil.LineProcessor();
  var dataString, endMarkIndex, testFile, testFileCallback, testFileTimeoutId;

  function onLine(line) {
    var result, filePath, end, resultObj;
    result = testUtil.parseResultLine(line);
    end = result[0];
    filePath = result[1];
    resultObj = result[2];

    if (end) {
      return;
    }

    if (resultObj.hasOwnProperty('coverage')) {
      self._handleTestCoverageResult(filePath, resultObj['coverage']);
    }
    else {
      self._handleTestResult(filePath, resultObj);
    }
  }

  lineProcessor.on('line', onLine);

  function onData(chunk) {
    lineProcessor.appendData(chunk);
    data += chunk;
  }

  connection.on('data', onData);
};

TestRunner.prototype._startServer = function(socketPath, connectionHandler,
                                             onBound) {
  socketPath = socketPath || constants.DEFAULT_SOCKET_PATH;
  this._server = net.createServer(connectionHandler);
  this._server.listen(socketPath, onBound);
};

TestRunner.prototype.forceStop = function() {
  var testFile, testFileData, child, timeoutId;

  this._forceStopped = true;
  for (testFile in this._testFilesData) {
    if (this._testFilesData.hasOwnProperty(testFile)) {
      testFileData = this._testFilesData[testFile];
      child = testFileData['child'];
      timeoutId = testFileData['timeout_id'];
      clearTimeout(timeoutId);
      child.kill('SIGTERM');
    }
  }
};

TestRunner.prototype._stopServer = function() {
  if (this._server.fd) {
    this._server.close();
  }
};

function run(cwd, argv) {
  var customAssertModule, exportedFunctions;
  var runner, testReporter, coverageReporter, coverageArgs;
  if ((argv === undefined) && (cwd instanceof Array)) {
    argv = cwd;
  }

  var p = parser.getParser();
  p.banner = 'Usage: whiskey [options] --tests "files"';
  var options = parser.parseArgv(p, argv);

  if (options.tests && options.tests.length > 0) {
    options.tests = options.tests.split(' ');

    customAssertModule = options['custom-assert-module'];
    if (customAssertModule) {
      if (path.existsSync(customAssertModule)) {
        customAssertModule = customAssertModule.replace(/$\.js/, '');
      }
      else {
        customAssertModule = null;
      }
    }

    var reporterOptions = {
      'print_stdout': options['print-stdout'],
      'print_stderr': options['print-stderr']
    };

    testReporter = reporters.getTestReporter(options['test-reporter'] || constants.DEFAULT_TEST_REPORTER,
                                             options['tests'], reporterOptions);

    if (options['coverage']) {
      require.paths.unshift('lib-cov');

      coverageArgs = [ 'jscoverage' ];

      if (options['coverage-encoding']) {
        coverageArgs.push(sprintf('--encoding=%s', options['coverage-encoding']));
      }

      if (options['coverage-exclude']) {
        coverageArgs.push(sprintf('--exclude=%s', options['coverage-exclude']));
      }

      coverageArgs.push(sprintf('lib %s', constants.COVERAGE_PATH));

      coverageArgs = coverageArgs.join(' ');
      exec(sprintf('rm -fr %s ; %s', constants.COVERAGE_PATH, coverageArgs), 
           function(err) {
        if (err) {
          if (err.message.match(/jscoverage: not found/i)) {
            err = new Error('jscoverage binary not found. To use test coverage ' +
                            ' you need to install node-jscoverag binary - ' +
                            'https://github.com/visionmedia/node-jscoverage');
          }

          throw err;
        }
      });

      var coverageOptions = {
        'directory': options['coverage-dir'],
      };

      coverageReporter = reporters.getCoverageReporter(options['coverage-reporter'] || constants.DEFAULT_COVERAGE_REPORTER,
                                                       options['tests'], coverageOptions);
    }
    else {
      coverageReporter = null;
    }

    runner = new TestRunner(options['tests'], testReporter, coverageReporter,
                            options['coverage'],
                            options['verbosity']);
    runner.runTests(options['test-init-file'], options['chdir'],
                    customAssertModule,
                    options['timeout'], options['concurrency'],
                    options['fail-fast']);
  }
  else {
    console.log(p.banner);
  }

  process.on('SIGINT', function onSigint() {
    runner.forceStop();
  });

  process.on('exit', function() {
    if (path.existsSync(path.join(process.cwd(), 'lib-cov'))) {
      exec('rm -rf lib-cov', function() {
        process.reallyExit(exitCode);
      });

      return;
    }

    process.reallyExit(exitCode);
  });
}

exports.run = run;
