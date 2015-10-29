/// Implements the process of managing a package's .npm directory,
/// in which we call `npm install` to install npm dependencies,
/// and a variety of related commands. Notably, we use `npm shrinkwrap`
/// to ensure we get consistent versions of npm sub-dependencies.
var Future = require('fibers/future');

var cleanup = require('../tool-env/cleanup.js');
var files = require('../fs/files.js');
var os = require('os');
var _ = require('underscore');
var httpHelpers = require('../utils/http-helpers.js');
var buildmessage = require('../utils/buildmessage.js');
var utils = require('../utils/utils.js');
var runLog = require('../runners/run-log.js');
var colonConverter = require('../utils/colon-converter.js');

var meteorNpm = exports;

// if a user exits meteor while we're trying to create a .npm
// directory, we will have temporary directories that we clean up
var tmpDirs = [];
cleanup.onExit(function () {
  _.each(tmpDirs, function (dir) {
    if (files.exists(dir))
      files.rm_recursive(dir);
  });
});

// Exception used internally to gracefully bail out of a npm run if
// something goes wrong
var NpmFailure = function () {};

// Creates a temporary directory in which the new contents of the
// package's .npm directory will be assembled. If all is successful,
// renames that directory back to .npm. Returns true if there are NPM
// dependencies and they are installed without error.
//
// @param npmDependencies {Object} dependencies that should be
//     installed, eg {tar: '0.1.6', gcd: '0.0.0'}. If falsey or empty,
//     will remove the .npm directory instead.
meteorNpm.updateDependencies = function (packageName,
                                         packageNpmDir,
                                         npmDependencies,
                                         quiet) {
  if (! npmDependencies || _.isEmpty(npmDependencies)) {
    // No NPM dependencies? Delete the .npm directory if it exists (because,
    // eg, we used to have NPM dependencies but don't any more).  We'd like to
    // do this in as atomic a way as possible in case multiple meteor
    // instances are trying to make this update in parallel, so we rename the
    // directory to something before doing the rm -rf.
    var tempPackageNpmDir = packageNpmDir + '-temp-' + utils.randomToken();
    try {
      files.rename(packageNpmDir, tempPackageNpmDir);
    } catch (e) {
      if (e.code !== 'ENOENT')
        throw e;
      // It didn't exist, which is exactly what we wanted.
      return false;
    }
    files.rm_recursive(tempPackageNpmDir);
    return false;
  }

  try {
    // v0.6.0 had a bug that could cause .npm directories to be
    // created without npm-shrinkwrap.json
    // (https://github.com/meteor/meteor/pull/927). Running your app
    // in that state causes consistent "Corrupted .npm directory"
    // errors.
    //
    // If you've reached that state, delete the empty directory and
    // proceed.
    if (files.exists(packageNpmDir) &&
        ! files.exists(files.pathJoin(packageNpmDir, 'npm-shrinkwrap.json'))) {
      files.rm_recursive(packageNpmDir);
    }

    if (files.exists(packageNpmDir)) {
      // we already nave a .npm directory. update it appropriately with some
      // ceremony involving:
      // `npm install`, `npm install name@version`, `npm shrinkwrap`
      updateExistingNpmDirectory(
        packageName, packageNpmDir, npmDependencies, quiet);
    } else {
      // create a fresh .npm directory with `npm install
      // name@version` and `npm shrinkwrap`
      createFreshNpmDirectory(
        packageName, packageNpmDir, npmDependencies, quiet);
    }
  } catch (e) {
    if (e instanceof NpmFailure) {
      // Something happened that was out of our control, but wasn't
      // exactly unexpected (eg, no such npm package, no internet
      // connection). Handle it gracefully.
      return false;
    }

    // Some other exception -- let it propagate.
    throw e;
  }

  return true;
};

// Return true if all of a package's npm dependencies are portable
// (that is, if the node_modules can be copied anywhere and we'd
// expect it to work, rather than containing native extensions that
// were built just for our architecture), else
// false. updateDependencies should first be used to bring
// packageNpmDir up to date.
meteorNpm.dependenciesArePortable = function (packageNpmDir) {
  // We use a simple heuristic: we check to see if a package (or any
  // of its transitive depedencies) contains any *.node files. .node
  // is the extension that signals to Node that it should load a file
  // as a shared object rather than as JavaScript, so this should work
  // in the vast majority of cases.

  var search = function (dir) {
    return _.find(files.readdir(dir), function (itemName) {
      if (itemName.match(/\.node$/))
        return true;
      var item = files.pathJoin(dir, itemName);
      if (files.lstat(item).isDirectory())
        return search(item);
    }) || false;
  };

  return ! search(files.pathJoin(packageNpmDir, 'node_modules'));
};

function updateExistingNpmDirectory(
  packageName,
  packageNpmDir,
  npmDependencies,
  quiet,
) {
  // sanity check on contents of .npm directory
  if (!files.stat(packageNpmDir).isDirectory())
    throw new Error("Corrupted .npm directory -- should be a directory: " +
                    packageNpmDir);
  if (!files.exists(files.pathJoin(packageNpmDir, 'npm-shrinkwrap.json')))
    throw new Error(
      "Corrupted .npm directory -- can't find npm-shrinkwrap.json in " +
        packageNpmDir);

  // We need to rebuild all node modules when the Node version
  // changes, in case there are some binary ones. Technically this is
  // racey, but it shouldn't fail very often.
  var nodeModulesDir = files.pathJoin(packageNpmDir, 'node_modules');
  if (files.exists(nodeModulesDir)) {
    var oldNodeVersion;
    try {
      oldNodeVersion = files.readFile(
        files.pathJoin(packageNpmDir, 'node_modules', '.node_version'), 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT')
        throw e;
      // Use the Node version from the last release where we didn't
      // drop this file.
      oldNodeVersion = 'v0.8.24';
    }

    if (oldNodeVersion !== currentNodeCompatibilityVersion())
      files.rm_recursive(nodeModulesDir);
  }

  // If the node modules directory exists but doesn't have .package.json and
  // .npm-shrinkwrap.json, recreate.  This is to ensure that
  // providePackageJSONForUnavailableBinaryDeps works.
  if (files.exists(nodeModulesDir) &&
      (!files.exists(files.pathJoin(nodeModulesDir, '.package.json')) ||
       !files.exists(files.pathJoin(nodeModulesDir, '.npm-shrinkwrap.json')))) {
    files.rm_recursive(nodeModulesDir);
  }

  const nodeModulesDirExisted = files.exists(nodeModulesDir);

  installNpmModules(npmDependencies, packageName, packageNpmDir);

  if (nodeModulesDirExisted) {
    // Since npm 3 prefers to install dependencies in the top-level
    // node_modules directory, quite often extraneous packages (or
    // duplicate packages with different versions) are left lying around
    // when an existing node_modules directory is updated (e.g. when a
    // Meteor package changes what it passes to Npm.depends).
    const pruneResult = runNpmCommand(["prune"], packageNpmDir);
    if (! pruneResult.success) {
      buildmessage.error(pruneResult);
    }

    const dedupeResult = runNpmCommand(["dedupe"], packageNpmDir);
    if (! dedupeResult.success) {
      buildmessage.error(dedupeResult);
    }

    // It's useful to see errors from `npm prune` and `npm dedupe`, but
    // they don't need to be fatal if `npm install` and `npm shrinkwrap`
    // both succeed.
  }

  completeNpmDirectory(packageName, packageNpmDir, npmDependencies);
};

function createFreshNpmDirectory(
  packageName,
  packageNpmDir,
  npmDependencies,
  quiet,
) {
  if (! quiet) {
    logUpdateDependencies(packageName, npmDependencies);
  }

  installNpmModules(npmDependencies, packageName, packageNpmDir);

  completeNpmDirectory(packageName, packageNpmDir, npmDependencies);
}

// Shared code for updateExistingNpmDirectory and createFreshNpmDirectory.
function completeNpmDirectory(packageName, packageNpmDir, npmDependencies) {
  // Create a shrinkwrap file.
  shrinkwrap(packageNpmDir);

  // Now get package.json out of the way, but put it somewhere where the
  // providePackageJSONForUnavailableBinaryDeps code can find it.
  files.rename(
    files.pathJoin(packageNpmDir, 'package.json'),
    files.pathJoin(packageNpmDir, 'node_modules', '.package.json'));

  // And stow a copy of npm-shrinkwrap too.
  files.copyFile(
    files.pathJoin(packageNpmDir, 'npm-shrinkwrap.json'),
    files.pathJoin(packageNpmDir, 'node_modules', '.npm-shrinkwrap.json'));

  createReadme(packageNpmDir);
  createNodeVersion(packageNpmDir);
  createGitIgnore(packageNpmDir);
}

function createReadme(packageNpmDir) {
  // This file gets checked in to version control by users, so resist the
  // temptation to make unnecessary tweaks to it.
  files.writeFile(
    files.pathJoin(packageNpmDir, 'README'),
"This directory and the files immediately inside it are automatically generated\n" +
"when you change this package's NPM dependencies. Commit the files in this\n" +
"directory (npm-shrinkwrap.json, .gitignore, and this README) to source control\n" +
"so that others run the same versions of sub-dependencies.\n" +
"\n" +
"You should NOT check in the node_modules directory that Meteor automatically\n" +
"creates; if you are using git, the .gitignore file tells git to ignore it.\n"
  );
}

function createNodeVersion(packageNpmDir) {
  files.writeFile(
    files.pathJoin(packageNpmDir, 'node_modules', '.node_version'),
    currentNodeCompatibilityVersion());
}

function createGitIgnore(packageNpmDir) {
  // create .gitignore -- node_modules shouldn't be in git since we
  // recreate it as needed by using `npm install`. since we use `npm
  // shrinkwrap` we're guaranteed to have the same version installed
  // each time.
  files.writeFile(files.pathJoin(packageNpmDir, '.gitignore'), [
    'node_modules',
    '' // git diff complains without trailing newline
  ].join('\n'));
}

// This value should change whenever we think that the Node C ABI has changed
// (ie, when we need to be sure to reinstall npm packages because they might
// have native components that need to be rebuilt). It does not need to change
// for every patch release of Node! Notably, it needed to change between 0.8.*
// and 0.10.*.  If Node does make a patch release of 0.10 that breaks
// compatibility, you can just change this from "0.10.*" to "0.10.35" or
// whatever.
function currentNodeCompatibilityVersion() {
  var version = process.version;
  version = version.replace(/\.(\d+)$/, '.*');
  return version + '\n';
}

function runNpmCommand(args, cwd) {
  const nodeBinDir = files.getCurrentNodeBinDir();
  var npmPath;

  if (os.platform() === "win32") {
    npmPath = files.convertToOSPath(
      files.pathJoin(nodeBinDir, "npm.cmd"));
  } else {
    npmPath = files.pathJoin(nodeBinDir, "npm");
  }

  if (meteorNpm._printNpmCalls) // only used by test-bundler.js
    process.stdout.write('cd ' + cwd + ' && ' + npmPath + ' ' +
                         args.join(' ') + ' ...\n');

  if (cwd)
    cwd = files.convertToOSPath(cwd);

  // It looks like some npm commands (such as build commands, specifically on
  // Windows) rely on having a global node binary present.
  // Sometimes users have a global node installed, so it is not
  // a problem, but a) it can be outdated and b) it can not be installed.
  // To solve this problem, we set the PATH env variable to have the path
  // containing the node binary we are running in right now as the highest
  // priority.
  // This hack is confusing as npm is supposed to do it already.
  const env = files.currentEnvWithPathsAdded(nodeBinDir);

  var opts = { cwd: cwd, env: env, maxBuffer: 10 * 1024 * 1024 };

  var future = new Future;
  var child_process = require('child_process');
  child_process.execFile(
    npmPath, args, opts, function (err, stdout, stderr) {
    if (meteorNpm._printNpmCalls)
      process.stdout.write(err ? 'failed\n' : 'done\n');

    future.return({
      success: ! err,
      error: (err ? `${err.message}${stderr}` : stderr),
      stdout: stdout,
      stderr: stderr
    });
  });

  return future.wait();
}

function constructPackageJson(packageName, packageNpmDir, npmDependencies) {
  var packageJsonContents = JSON.stringify({
    // name and version are unimportant but required for `npm install`.
    name: 'packages-for-meteor-' + colonConverter.convert(packageName),
    version: '0.0.0',
    dependencies: npmDependencies
  }, null, 2) + "\n";
  var packageJsonPath = files.pathJoin(packageNpmDir, 'package.json');
  files.writeFile(packageJsonPath, packageJsonContents);
}

// Gets a JSON object from `npm ls --json` (getInstalledDependenciesTree) or
// `npm-shrinkwrap.json` (getShrinkwrappedDependenciesTree).
//
// @returns {Object} eg {
//   "name": "packages",
//   "version": "0.0.0",
//   "dependencies": {
//     "sockjs": {
//       "version": "0.3.4",
//       "dependencies": {
//         "node-uuid": {
//           "version": "1.3.3"
//         }
//       }
//     }
//   }
// }
function getInstalledDependenciesTree(dir) {
  var result = runNpmCommand(["ls", "--json"], dir);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    if (! result.success) {
      buildmessage.error("couldn't read npm version lock information: " + result.error);
      // Recover by returning false from updateDependencies
      throw new NpmFailure;
    }
    throw error;
  }
}

function getShrinkwrappedDependenciesTree(dir) {
  var shrinkwrapFile = files.readFile(files.pathJoin(dir, 'npm-shrinkwrap.json'));
  return JSON.parse(shrinkwrapFile);
}

// Maps a "dependency object" (a thing you find in `npm ls --json` or
// npm-shrinkwrap.json with keys like "version" and "from") to the
// canonical version that matches what users put in the `Npm.depends`
// clause.  ie, either the version or the tarball URL.
//
// If more logic is added here, it should probably go in minimizeModule too.
function canonicalVersion(depObj) {
  if (utils.isUrlWithSha(depObj.from))
    return depObj.from;
  else
    return depObj.version;
}

// map the structure returned from `npm ls` or shrinkwrap.json into
// the structure of npmDependencies (e.g. {gcd: '0.0.0'}), so that
// they can be diffed. This only returns top-level dependencies.
function treeToDependencies(tree) {
  return _.object(
    _.map(
      tree.dependencies, function (properties, name) {
        return [name, canonicalVersion(properties)];
      }));
}

function getInstalledDependencies(dir) {
  return treeToDependencies(getInstalledDependenciesTree(dir));
}

// (appears to not be called)
function getShrinkwrappedDependencies(dir) {
  return treeToDependencies(getShrinkwrappedDependenciesTree(dir));
}

function installNpmModules(npmDependencies, packageName, packageNpmDir) {
  // Make sure node_modules is present (fix for #1761). Prevents npm
  // install from installing to an existing node_modules dir higher up in
  // the filesystem.  node_modules may be absent due to a change in Node
  // version or when `meteor add`ing a cloned package for the first time
  // (node_modules is excluded by .gitignore)
  files.mkdir_p(files.pathJoin(packageNpmDir, "node_modules"));

  constructPackageJson(packageName, packageNpmDir, npmDependencies);

  ensureConnected();

  const args = ["install"];
  const installed = getInstalledDependencies(packageNpmDir);
  _.each(npmDependencies, (version, name) => {
    if (installed[name] !== version) {
      const installArg = utils.isUrlWithSha(version)
        ? version : (name + "@" + version);
      args.push(installArg);
    }
  });

  const result = runNpmCommand(args, packageNpmDir);
  if (! result.success) {
    const missingPattern = /404 '(\S+?)' is not in the npm registry/;
    const badVersionPattern = /No compatible version found: ([^@]+)@(\S+)/;

    let match = missingPattern.exec(result.stderr);
    if (match) {
      buildmessage.error("there is no npm package named '" + match[1] + "'");
    } else if ((match = badVersionPattern.exec(result.stderr))) {
      buildmessage.error(
        match[1] + " version " +
        match[2] + " is not available in the npm registry"
      );
    } else {
      buildmessage.error(result.error);
    }

    throw new NpmFailure;
  }

  if (process.platform !== "win32") {
    // If we are on a unixy file system, we should not build a package that
    // can't be used on Windows.

    var pathsWithColons = files.findPathsWithRegex(".", /:/, {
      cwd: files.pathJoin(packageNpmDir, "node_modules")
    });

    if (pathsWithColons.length) {
      var firstTen = pathsWithColons.slice(0, 10);
      if (pathsWithColons.length > 10) {
        firstTen.push("... " + (pathsWithColons.length - 10) +
          " paths omitted.");
      }

      buildmessage.error(
"Some filenames in your package have invalid characters.\n" +
"The following file paths have colons, ':', which won't work on Windows:\n" +
firstTen.join("\n"));

      throw new NpmFailure;
    }
  }
}

// ensure we can reach http://npmjs.org before we try to install
// dependencies. `npm install` times out after more than a minute.
function ensureConnected() {
  try {
    httpHelpers.getUrl("http://registry.npmjs.org");
  } catch (e) {
    buildmessage.error("Can't install npm dependencies. " +
                       "Are you connected to the internet?");
    // Recover by returning false from updateDependencies
    throw new NpmFailure;
  }
}

// `npm shrinkwrap`
function shrinkwrap(dir) {
  // We don't use npm.commands.shrinkwrap for two reasons:
  // 1. As far as we could tell there's no way to completely silence the output
  //    (the `silent` flag isn't piped in to the call to npm.commands.ls)
  // 2. In various (non-deterministic?) cases we observed the
  //    npm-shrinkwrap.json file not being updated
  var result = runNpmCommand(["shrinkwrap"], dir);

  if (! result.success) {
    buildmessage.error(`couldn't run \`npm shrinkwrap\`: ${result.error}`);
    // Recover by returning false from updateDependencies
    throw new NpmFailure;
  }

  minimizeShrinkwrap(dir);
}

// The shrinkwrap file format contains a lot of extra data that can
// change as you re-run the NPM-update process without actually
// affecting what is installed. This step trims everything but the
// most important bits from the file, so that the file doesn't change
// unnecessary.
//
// This is based on an analysis of install.js in the npm module:
//   https://github.com/isaacs/npm/blob/master/lib/install.js
// It appears that the only things actually read from a given
// dependency are its sub-dependencies and a single version, which is
// read by the readWrap function; and furthermore, we can just put all
// versions in the "version" field.
function minimizeShrinkwrap(dir) {
  var topLevel = getShrinkwrappedDependenciesTree(dir);
  var minimized = minimizeDependencyTree(topLevel);

  files.writeFile(
    files.pathJoin(dir, 'npm-shrinkwrap.json'),
    // Matches the formatting done by 'npm shrinkwrap'.
    JSON.stringify(minimized, null, 2) + '\n');
}

// Reduces a dependency tree (as read from a just-made npm-shrinkwrap.json or
// from npm ls --json) to just the versions we want. Returns an object that does
// not share state with its input
function minimizeDependencyTree(tree) {
  var minimizeModule = function (module) {
    var version;
    if (module.resolved &&
        !module.resolved.match(/^https:\/\/registry.npmjs.org\//)) {
      version = module.resolved;
    } else if (utils.isUrlWithSha(module.from)) {
      version = module.from;
    } else {
      version = module.version;
    }
    var minimized = {version: version};

    if (module.dependencies) {
      minimized.dependencies = {};
      _.each(module.dependencies, function (subModule, name) {
        minimized.dependencies[name] = minimizeModule(subModule);
      });
    }
    return minimized;
  };

  var newTopLevelDependencies = {};
  _.each(tree.dependencies, function (module, name) {
    newTopLevelDependencies[name] = minimizeModule(module);
  });
  return {dependencies: newTopLevelDependencies};
}

function logUpdateDependencies(packageName, npmDependencies) {
  runLog.log(packageName + ': updating npm dependencies -- ' +
             _.keys(npmDependencies).join(', ') + '...');
}

exports.runNpmCommand = runNpmCommand;
