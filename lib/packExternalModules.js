'use strict';

const BbPromise = require('bluebird');
const _ = require('lodash');
const path = require('path');
const childProcess = require('child_process');
const fse = require('fs-extra');
const npm = require('npm-programmatic');
const isBuiltinModule = require('is-builtin-module');

function getProdModules(externalModules, packagePath, dependencyGraph) {
  const packageJsonPath = path.join(process.cwd(), packagePath);
  const packageJson = require(packageJsonPath);
  const prodModules = [];

  // only process the module stated in dependencies section
  if (!packageJson.dependencies) {
    return [];
  }

  // Get versions of all transient modules
  _.forEach(externalModules, module => {
    let moduleVersion = packageJson.dependencies[module.external];

    if (moduleVersion) {
      prodModules.push(`${module.external}@${moduleVersion}`);
    } else if (!_.has(packageJson, `devDependencies.${module.external}`)) {
      // Add transient dependencies if they appear not in the service's dev dependencies
      const originInfo = _.get(dependencyGraph, `dependencies.${module.origin}`, {});
      moduleVersion = _.get(originInfo, `dependencies.${module.external}.version`);
      if (!moduleVersion) {
        this.serverless.cli.log(`WARNING: Could not determine version of module ${module.external}`);
      }
      prodModules.push(moduleVersion ? `${module.external}@${moduleVersion}` : module.external);
    }
  });

  return prodModules;
}

function getExternalModuleName(module) {
  const path = /^external "(.*)"$/.exec(module.identifier())[1];
  const pathComponents = path.split('/');
  const main = pathComponents[0];

  // this is a package within a namespace
  if (main.charAt(0) == '@') {
    return `${main}/${pathComponents[1]}`;
  }

  return main;
}

function isExternalModule(module) {
  return _.startsWith(module.identifier(), 'external ') && !isBuiltinModule(getExternalModuleName(module));
}

/**
 * Find the original module that required the transient dependency. Returns
 * undefined if the module is a first level dependency.
 * @param {Object} issuer - Module issuer
 */
function findExternalOrigin(issuer) {
  if (!_.isNil(issuer) && _.startsWith(issuer.rawRequest, './')) {
    return findExternalOrigin(issuer.issuer);
  }
  return issuer;
}

function getExternalModules(stats) {
  const externals = new Set();

  _.forEach(stats.compilation.chunks, chunk => {
    // Explore each module within the chunk (built inputs):
    _.forEach(chunk.modules, module => {
      if (isExternalModule(module)) {
        externals.add({
          origin: _.get(findExternalOrigin(module.issuer), 'rawRequest'),
          external: getExternalModuleName(module)
        });
      }
    });
  });

  return Array.from(externals);
}

module.exports = {
  /**
   * We need a performant algorithm to install the packages for each single
   * function (in case we package individually).
   * (1) We fetch ALL packages needed by ALL functions in a first step
   * and use this as a base npm checkout. The checkout will be done to a
   * separate temporary directory with a package.json that contains everything.
   * (2) For each single compile we copy the whole node_modules to the compile
   * directory and create a (function) compile specific package.json and store
   * it in the compile directory. Now we start npm again there, and npm will just
   * remove the superfluous packages and optimize the remaining dependencies.
   * This will utilize the npm cache at its best and give us the needed results
   * and performance.
   */
  packExternalModules(stats) {

    const includes = (
      this.serverless.service.custom &&
      this.serverless.service.custom.webpackIncludeModules
    );

    if (!includes) {
      return BbPromise.resolve(stats);
    }

    const packagePath = includes.packagePath || './package.json';
    const packageJsonPath = path.join(process.cwd(), packagePath);

    this.options.verbose && this.serverless.cli.log(`Fetch dependency graph from ${packageJsonPath}`);
    // Get first level dependency graph
    const command = 'npm ls -prod -json -depth=1';  // Only prod dependencies
    let dependencyGraph = {};
    try {
      const depJson = childProcess.execSync(command, {
        cwd: path.dirname(packageJsonPath),
        maxBuffer: this.serverless.service.custom.packExternalModulesMaxBuffer || 200 * 1024,
        encoding: 'utf8'
      });
      dependencyGraph = JSON.parse(depJson);
    } catch (e) {
      // We rethrow here. It's not recoverable.
      throw e;
    }

    // (1) Generate dependency composition
    const compositeModules = _.uniq(_.flatMap(stats.stats, compileStats => {
      const externalModules = getExternalModules.call(this, compileStats);
      return getProdModules.call(this, externalModules, packagePath, dependencyGraph);
    }));

    // (1.a) Install all needed modules
    const compositeModulePath = path.join(this.webpackOutputPath, 'dependencies');
    const compositePackageJson = path.join(compositeModulePath, 'package.json');
    this.serverless.utils.writeFileSync(compositePackageJson, '{}');

    this.serverless.cli.log('Packing external modules: ' + compositeModules.join(', '));

    return new BbPromise((resolve, reject) => {
      const start = _.now();
      npm.install(compositeModules, {
        cwd: compositeModulePath,
        maxBuffer: this.serverless.service.custom.packExternalModulesMaxBuffer || 200 * 1024,
        save: true
      }).then(() => {
        this.options.verbose && this.serverless.cli.log(`Package took [${_.now() - start} ms]`);    // eslint-disable-line promise/always-return
        resolve(stats.stats);
      }).catch(e => {
        reject(e);
      });
    })
    .mapSeries(compileStats => {
      const modulePath = compileStats.compilation.compiler.outputPath;

      // Create package.json
      const modulePackageJson = path.join(modulePath, 'package.json');
      const modulePackage = {
        dependencies: {}
      };
      const prodModules = getProdModules.call(this, getExternalModules.call(this, compileStats), packagePath, dependencyGraph);
      _.forEach(prodModules, prodModule => {
        const splitModule = _.split(prodModule, '@');
        // If we have a scoped module we have to re-add the @
        if (_.startsWith(prodModule, '@')) {
          splitModule.splice(0, 1);
          splitModule[0] = '@' + splitModule[0];
        }
        const moduleVersion = _.join(_.tail(splitModule), '@');
        modulePackage.dependencies[_.first(splitModule)] = moduleVersion;
      });
      this.serverless.utils.writeFileSync(modulePackageJson, JSON.stringify(modulePackage, null, 2));

      // Copy modules
      const startCopy = _.now();
      return BbPromise.fromCallback(callback => fse.copy(path.join(compositeModulePath, 'node_modules'), path.join(modulePath, 'node_modules'), callback))
      .tap(() => this.options.verbose && this.serverless.cli.log(`Copy modules: ${modulePath} [${_.now() - startCopy} ms]`))
      .then(() => {
        // Prune extraneous packages - removes not needed ones
        const startPrune = _.now();
        return BbPromise.fromCallback(callback => {
          childProcess.exec('npm prune', {
            cwd: modulePath
          }, callback);
        })
        .tap(() => this.options.verbose && this.serverless.cli.log(`Prune: ${modulePath} [${_.now() - startPrune} ms]`));
      });
    })
    .return(stats);
  }
};
