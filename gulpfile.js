"use strict";

var args = require('minimist')(process.argv.slice(2));
var gulp = require('gulp');
var bower = require('gulp-bower');
var map = require('map-stream');
var fs = require('fs-extra');
var globalVar = require('./template/tasks/global-variables');
var gutil = require('gulp-util');
var _ = require('lodash');
var runSequence = require('run-sequence');
const {Analyzer, FSUrlLoader, generateAnalysis} = require('polymer-analyzer');
var jsonfile = require('jsonfile');
var StreamFromArray = require('stream-from-array');
var rename = require("gulp-rename");
var marked = require('marked');

var libDir = __dirname + '/lib/';
var tplDir = __dirname + '/template/';

var helpers = require(tplDir + "helpers");
require('require-dir')(tplDir + 'tasks');

// Using global because if we try to pass it to templates via the helper or any object
// we need to call merge which makes a copy of the structure per template slowing down
// the performance.
global.parsed = []; // we store all parsed objects so as we can iterate or find behaviors

gulp.task('clean:target', function () {
    fs.removeSync(globalVar.clientDir + 'element');
    fs.removeSync(globalVar.clientDir + 'widget');
});

gulp.task('clean:resources', function () {
    fs.removeSync(globalVar.publicDir);
});

gulp.task('clean', ['clean:target', 'clean:resources']);

gulp.task('bower:configure', ['clean:resources'], function (done) {
    jsonfile.readFile('.bowerrc', function (err, obj) {
        if (!err) {
            fs.copySync('.bowerrc', globalVar.publicDir + '/.bowerrc');
            if (obj.directory) {
                globalVar.bowerDir = globalVar.publicDir + '/' + obj.directory + '/';
            }
        }
        done();
    });
});

gulp.task('bower:install', ['clean', 'bower:configure'], function () {
    if (globalVar.bowerPackages) {
        return bower({cmd: 'install', cwd: globalVar.publicDir, interactive: true}, [globalVar.bowerPackages]);
    } else {
        gutil.log('No --package provided. Using package(s) from bower_components folder.');
        return gulp.src('./bower_components/**/*', {base: '.'}).pipe(gulp.dest(globalVar.publicDir));
    }
});

gulp.task('parse', ['analyze'], function (cb) {
    global.parsed.forEach(function (item) {
        if (!helpers.isBehavior(item) && item.behaviors && item.behaviors.length) {
            item.behaviors.forEach(function (name) {
                var nestedBehaviors = helpers.getNestedBehaviors(item, name);
                item.properties = _.union(item.properties, nestedBehaviors.properties);

                // merge events
                if (nestedBehaviors.events && nestedBehaviors.events.length) {
                    nestedBehaviors.events.forEach(function (event) {
                        var notDuplicate = _.filter(item.events, function (e) {
                            return e.name == event.name;
                        }).length === 0;
                        if (notDuplicate) {
                            item.events.push(event);
                        }
                    });
                }
            });
        }

        //remove private and unwanted properties
        const unwantedProps = ['root', 'rootPath', 'importPath', '$'];
        let props = [];
        if (item.properties) {
            item.properties.forEach(function (prop) {
                if (!unwantedProps.includes(prop.name) && prop.privacy === "public") {
                    props.push(prop);
                }
            });
        }
        item.properties = props;
    });
    cb();
});

gulp.task('analyze', ['clean:target', 'pre-analyze'], function () {
    return gulp.src([globalVar.bowerDir + "*/*.html",
        // vaadin elements
        globalVar.bowerDir + "*/vaadin-*/vaadin-*.html",
        // ignore all demo.html, index.html and metadata.html files
        "!" + globalVar.bowerDir + "*/*demo.html",
        "!" + globalVar.bowerDir + "*/*index.html",
        "!" + globalVar.bowerDir + "*/*metadata.html",
        // includes a set of js files only, and some do not exist
        "!" + globalVar.bowerDir + "*/*web-animations.html",
        // Not useful in gwt and also has spurious event names
        "!" + globalVar.bowerDir + "*/*iron-jsonp-library.html",
        //
        "!" + globalVar.bowerDir + "*/iron-doc*.html",
    ])
        .pipe(map(function (file, cb) {
            const componentLocation = file.relative.split('/');
            const componentDirectory = componentLocation[0];
            const componentFile = componentLocation[1];

            let analyzer = new Analyzer({
                urlLoader: new FSUrlLoader(file.base + componentDirectory + "/")
            });

            if (componentDirectory !== 'polymer') {
                // This path is relative to the package root
                analyzer.analyze([componentFile]).then((analysis) => {

                    let result = generateAnalysis(analysis, '');

                    let behaviors = [];
                    if (result.metadata && result.metadata.polymer && result.metadata.polymer.behaviors) {
                        result.metadata.polymer.behaviors.forEach(function (behavior) {
                            behavior.type = 'behavior';
                        });
                        behaviors = result.metadata.polymer.behaviors;
                    }

                    let jsonArray = _.union(result.elements, behaviors);

                    jsonArray.forEach(function (item) {
                        let path = file.relative.replace(/\\/, '/');

                        //poly1 and hybrid analysis doesn't have name prop
                        if (!item.name) {
                            item.name = _.camelCase(item.tagname);
                            item.name = item.name.charAt(0).toUpperCase() + item.name.slice(1);
                        }

                        item.name = item.name.replace(/Polymer\./, '');

                        item.path = path;

                        let bowerFile = file.base + path.split("/")[0] + "/bower.json";
                        let bowerFileContent = fs.readFileSync(bowerFile);
                        item.bowerData = bowerFileContent ? JSON.parse(bowerFileContent) : {};

                        // Save all items in an array for later processing
                        global.parsed.push(item);
                    });
                    cb(null, file);
                })
                    ['catch'](function (e) {
                    gutil.log(e.stack);
                    cb(null, file);
                });
            }
        }));
});

// Parse a template and generates a .java file.
// template: file in the templates folder
// obj:      context object for the template
// name:     name of the item parsed
// dir:      folder relative to the client folder to write the file
// suffix:   extra suffix for the name
function parseTemplate(template, obj, name, dir, suffix) {
    var className = helpers.camelCase(name) + suffix;
    // If there is a base .java file we extend it.
    var classBase = helpers.camelCase(name) + suffix + "Base";

    // We have to compute the appropriate name-space for the component.
    var prefix =
        // For events we prefer the first word of the name if they are standard ones.
        /^Event/.test(suffix) && /^(polymer|iron|paper|neon)-/.test(name) ? name :
            // Otherwise we try the name from its bower.json, then the sub-folder name in
            // bower_components, and finally from its name.
            obj.bowerData && obj.bowerData.name || obj.path.replace(/.*\/+(.+)\/+[^\/]+/, '$1') || name;
    //  Then we take the first part before first dash
    prefix = prefix.split('-')[0].replace(/\./g, '');

    obj.ns = globalVar.ns + '.' + prefix;

    let propertyNames = [];
    obj.properties.forEach(function (prop) {
        propertyNames.push(prop.name);
    });
    obj.methods.forEach(function (method) {
        if (propertyNames.includes(_.lowerFirst(method.name.replace(/get/, '').replace(/set/, '')))) {
            method.duplicate = true;
        }
    });

    if (obj.superclass === 'Polymer.Element' || obj.superclass === 'HTMLElement') {
        obj.superclass = 'Polymer';
    }

    var targetPath = globalVar.clientDir + prefix + '/' + dir;
    var targetFile = targetPath + className + ".java";
    fs.ensureFileSync(targetFile);

    gutil.log("Generating: ", targetFile);
    var tpl = _.template(fs.readFileSync(tplDir + template + '.template'));
    fs.writeFileSync(targetFile, new Buffer(tpl(_.merge({}, null, obj, helpers))));
}

gulp.task('generate:elements', ['parse'], function () {
    return StreamFromArray(global.parsed, {objectMode: true})
        .on('data', function (item) {
            if (helpers.isBehavior(item)) {
                parseTemplate('Behavior', item, item.name, '', '');
            } else {
                parseTemplate('Element', item, item.name, '', 'Element');
            }
        });
});

gulp.task('generate:events', ['parse'], function () {
    return StreamFromArray(global.parsed, {objectMode: true})
        .on('data', function (item) {
            if (item.events) {
                item.events.forEach(function (event) {
                    event.bowerData = item.bowerData;
                    event.name = event.name.replace(/\s.*$/, '');
                    parseTemplate('ElementEvent', event, event.name, 'event/', 'Event');
                });
            }
        });
});

gulp.task('generate:widgets', ['parse'], function () {
    return StreamFromArray(global.parsed, {objectMode: true})
        .on('data', function (item) {
            if (!helpers.isBehavior(item)) {
                parseTemplate('Widget', item, item.name, 'widget/', '');
            }
        });
});

gulp.task('generate:widget-events', ['parse'], function () {
    return StreamFromArray(global.parsed, {objectMode: true})
        .on('data', function (item) {
            if (item.events) {
                item.events.forEach(function (event) {
                    event.bowerData = item.bowerData;
                    event.name = event.name.replace(/\s.*$/, '');
                    parseTemplate('WidgetEvent', event, event.name, 'widget/event/', 'Event');
                    parseTemplate('WidgetEventHandler', event, event.name, 'widget/event/', 'EventHandler');
                });
            }
        });
});

gulp.task('generate:gwt-module', function () {
    if (globalVar.moduleName != 'Elements' || globalVar.ns != 'com.vaadin.polymer') {
        var dest = globalVar.publicDir.replace(/[^\/]+\/?$/, '');
        gutil.log("Generating Module: " + dest + globalVar.moduleName + ".gwt.xml");
        return gulp.src(tplDir + "GwtModule.template")
            .pipe(rename(globalVar.moduleName + ".gwt.xml"))
            .pipe(gulp.dest(dest));
    }
});

gulp.task('generate:elements-all', ['generate:elements', 'generate:events']);

gulp.task('generate:widgets-all', ['generate:widgets', 'generate:widget-events']);

gulp.task('generate', ['generate:elements-all', 'generate:widgets-all', 'generate:gwt-module'], function () {
    gutil.log('Done.');
});

gulp.task('copy:lib', function () {
    if (!args.excludeLib) {
        return gulp.src(libDir + '**')
            .pipe(gulp.dest(globalVar.clientDirBase));
    }
});

gulp.task('copy:pom', function () {
    var tpl = _.template(fs.readFileSync(tplDir + "pom.template"));
    var pom = globalVar.currentDir + "pom.xml";

    // Try to get some configuration from a package.json
    // otherwise use default values
    var pkgFile = globalVar.currentDir + 'package.json';
    globalVar.pkg = {};
    try {
        var pkgContent = fs.readFileSync(pkgFile);
        globalVar.pkg = JSON.parse(pkgContent);
    } catch (ignore) {
    }
    globalVar.pkg.pom = globalVar.pkg.pom || {};
    globalVar.pkg.pom.version = args.version || globalVar.pkg.pom.version || globalVar.pkg.version;

    fs.ensureFileSync(pom);
    fs.writeFileSync(pom, new Buffer(tpl(_.merge({}, null, globalVar, helpers))));
});

gulp.task('default', function () {
    if (args.pom) {
        runSequence('clean', 'bower:install', 'generate', 'copy:lib', 'copy:pom');
    } else {
        runSequence('clean', 'bower:install', 'generate', 'copy:lib');
    }
});
