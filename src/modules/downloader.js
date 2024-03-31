const fs = require('fs');
const fse = require('fs-extra');
const { https } = require('follow-redirects');
const constants = require('../constants');
const config = require('./config');
const utils = require('../utils');
const decompress = require('decompress');

let cachedLatestClientVersion = null;

let getLatestVersion = (repo, proxy) => {
    return new Promise((resolve, reject) => {
        function fallback() {
            utils.warn('Unable to fetch the latest version tag from GitHub. Using nightly releases...');
            resolve('nightly');
        }

        let opt = {
            headers: {'User-Agent': 'Neutralinojs CLI'}
        };
        if (proxy) {
            opt.proxy = proxy;
        }
        https.get(constants.remote.releasesApiUrl.replace('{repo}', repo), opt, function (response) {
            let body = '';
            response.on('data', (data) => body += data);
            response.on('end', () => {
                if(response.statusCode != 200) {
                    return fallback();
                }
                let apiRes = JSON.parse(body);
                let version = apiRes.tag_name.replace('v', '');
                utils.log(`Found the latest release tag ${utils.getVersionTag(version)} for ${repo}...`);
                resolve(version);
            });
            response.on('error', () => {
                fallback();
            });
        });
    });
}

let getScriptExtension = () => {
    const configObj = config.get();
    let clientLibrary = configObj.cli.clientLibrary;
    return clientLibrary.includes('.mjs') ? 'mjs' : 'js';
}

let getBinaryDownloadUrl = async (latest, proxy) => {
    const configObj = config.get();
    let version = configObj.cli.binaryVersion;

    if(!version || latest) {
        version = await getLatestVersion('neutralinojs', proxy);
        config.update('cli.binaryVersion', version);
    }
    return constants.remote.binariesUrl
        .replace(/{tag}/g, utils.getVersionTag(version));
}

let getClientDownloadUrl = async (latest, proxy, types = false) => {
    const configObj = config.get();
    let version = configObj.cli.clientVersion;

    if(!version || latest) {
        if(cachedLatestClientVersion) {
            version = cachedLatestClientVersion;
        }
        else {
            version = await getLatestVersion('neutralino.js', proxy);
        }
        cachedLatestClientVersion = version;
        config.update('cli.clientVersion', version);
    }

    let scriptUrl = constants.remote.clientUrlPrefix + (types ? 'd.ts' : getScriptExtension());
    return scriptUrl
            .replace(/{tag}/g, utils.getVersionTag(version));
}

let getTypesDownloadUrl = (latest, proxy) => {
    return getClientDownloadUrl(latest, proxy, true);
}

let getRepoNameFromTemplate = (template) => {
    return template.split('/')[1];
}

let downloadBinariesFromRelease = (latest, proxy) => {
    return new Promise((resolve, reject) => {
        fs.mkdirSync('.tmp', { recursive: true });
        const zipFilename = '.tmp/binaries.zip';
        const file = fs.createWriteStream(zipFilename);
        utils.log('Downloading Neutralinojs binaries..');
        getBinaryDownloadUrl(latest, proxy)
            .then((url) => {
                const options = {};
                if (proxy) {
                    options.proxy = proxy;
                }
                https.get(url, options, function (response) {
                    response.pipe(file);
                    response.on('end', () => {
                        utils.log('Extracting binaries.zip file...');
                        decompress(zipFilename, '.tmp/')
                            .then(() => resolve())
                            .catch((e) => reject(e));
                    });
                });
        });
    });
}

let downloadClientFromRelease = (latest, proxy) => {
    return new Promise((resolve, reject) => {
        fs.mkdirSync('.tmp', { recursive: true });
        const file = fs.createWriteStream('.tmp/neutralino.' + getScriptExtension());
        utils.log('Downloading the Neutralinojs client..');
        getClientDownloadUrl(latest, proxy)
            .then((url) => {
                const options = {};
                if (proxy) {
                    options.proxy = proxy;
                }
                https.get(url, options, function (response) {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });
                });
            });
    });
}

let downloadTypesFromRelease = (latest, proxy) => {
    return new Promise((resolve, reject) => {
        fs.mkdirSync('.tmp', { recursive: true });
        const file = fs.createWriteStream('.tmp/neutralino.d.ts');
        utils.log('Downloading the Neutralinojs types..');

        getTypesDownloadUrl(latest, proxy)
            .then((url) => {
                const options = {};
                if (proxy) {
                    options.proxy = proxy;
                }
                https.get(url, options, function (response) {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });
                });
            });
    });
}

module.exports.downloadTemplate = (template, proxy) => {
    return new Promise((resolve, reject) => {
        let templateUrl = constants.remote.templateUrl.replace('{template}', template);
        fs.mkdirSync('.tmp', { recursive: true });
        const zipFilename = '.tmp/template.zip';
        const file = fs.createWriteStream(zipFilename);
        const options = {};
        if (proxy) {
            options.proxy = proxy;
        }
        https.get(templateUrl, options, function (response) {
            response.pipe(file);
            response.on('end', () => {
                utils.log('Extracting template zip file...');
                decompress(zipFilename, '.tmp/')
                    .then(() => {
                        fse.copySync(`.tmp/${getRepoNameFromTemplate(template)}-main`, '.');
                        utils.clearDirectory('.tmp');
                        resolve();
                    })
                    .catch((e) => reject(e));
            });
        });
    });
}

module.exports.downloadAndUpdateBinaries = async (latest = false, proxy) => {
    await downloadBinariesFromRelease(latest, proxy);
    utils.log('Finalizing and cleaning temp. files.');
    if(!fse.existsSync('bin'))
        fse.mkdirSync('bin');

    for(let platform in constants.files.binaries) {
        for(let arch in constants.files.binaries[platform]) {
            let binaryFile = constants.files.binaries[platform][arch];
            if(fse.existsSync(`.tmp/${binaryFile}`)) {
                fse.copySync(`.tmp/${binaryFile}`, `bin/${binaryFile}`);
            }
        }
    }

    for(let dependency of constants.files.dependencies) {
        fse.copySync(`.tmp/${dependency}`,`bin/${dependency}`);
    }
    utils.clearDirectory('.tmp');
}

module.exports.downloadAndUpdateClient = async (latest = false, proxy) => {
    const configObj = config.get();
    if(!configObj.cli.clientLibrary) {
        utils.log(`neu CLI won't download the client library --` +
                    ` download @neutralinojs/lib from your Node package manager.`);
        return;
    }
    const clientLibrary = utils.trimPath(configObj.cli.clientLibrary);
    await downloadClientFromRelease(latest, proxy);
    await downloadTypesFromRelease(latest, proxy);
    utils.log('Finalizing and cleaning temp. files...');
    fse.copySync(`.tmp/${constants.files.clientLibraryPrefix + getScriptExtension()}`
            , `./${clientLibrary}`);
    fse.copySync(`.tmp/neutralino.d.ts`
            , `./${clientLibrary.replace(/[.][a-z]*$/, '.d.ts')}`);
    utils.clearDirectory('.tmp');
}
