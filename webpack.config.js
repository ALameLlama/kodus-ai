const fs = require('fs');
const path = require('path');
const nodeExternals = require('webpack-node-externals');
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');
const { RunScriptWebpackPlugin } = require('run-script-webpack-plugin');

const copyDir = (sourceDir, targetDir) => {
    if (!fs.existsSync(sourceDir)) {
        return;
    }

    fs.mkdirSync(targetDir, { recursive: true });

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);

        if (entry.isDirectory()) {
            copyDir(sourcePath, targetPath);
        } else {
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
};

class CopyDictionariesPlugin {
    apply(compiler) {
        compiler.hooks.afterEmit.tap('CopyDictionariesPlugin', () => {
            const sourceDir = path.resolve(
                __dirname,
                'libs/common/utils/translations/dictionaries',
            );
            const targetDir = path.resolve(__dirname, 'dist', 'dictionaries');

            copyDir(sourceDir, targetDir);
        });
    }
}

module.exports = function (options, webpack) {
    const isWatchMode = Boolean(options.watch);
    const isNestCliStart = process.env.NEST_CLI_START === 'true';
    const isProduction = process.env.NODE_ENV === 'production';
    const debugPort = process.env.DEBUG_PORT || 9229;
    const debugBreak = process.env.DEBUG_BREAK === 'true';
    const inspectArg = debugBreak ? '--inspect-brk' : '--inspect';
    const devtool = isWatchMode
        ? 'inline-source-map'
        : isProduction
          ? 'hidden-source-map'
          : 'source-map';

    const plugins = [...options.plugins];
    plugins.push(new CopyDictionariesPlugin());

    // Only run the compiled output (and enable HMR) in watch mode.
    // In CI/Docker builds we only want to compile, not start the app.
    if (isWatchMode) {
        plugins.push(
            new webpack.HotModuleReplacementPlugin(),
            new webpack.WatchIgnorePlugin({
                paths: [/\.js$/, /\.d\.ts$/],
            }),
        );

        if (!isNestCliStart) {
            plugins.push(
                new RunScriptWebpackPlugin({
                    name: options.output.filename,
                    autoRestart: false,
                    nodeArgs: [`${inspectArg}=0.0.0.0:${debugPort}`],
                }),
            );
        }
    }

    return {
        ...options,
        stats: 'errors-warnings',
        devtool,
        optimization: {
            ...options.optimization,
            moduleIds: 'named',
        },
        cache: {
            type: 'filesystem',
            version: '1',
            buildDependencies: {
                config: [__filename],
            },
        },
        externals: [
            nodeExternals({
                allowlist: [],
            }),
        ],
        output: {
            ...options.output,
            devtoolModuleFilenameTemplate: (info) => {
                return info.absoluteResourcePath.replace(/\\/g, '/');
            },
        },
        resolve: {
            plugins: [
                new TsconfigPathsPlugin({ configFile: './tsconfig.json' }),
            ],
            extensions: ['.ts', '.tsx', '.js', '.json'],
        },
        plugins,
        watchOptions: {
            aggregateTimeout: 300,
            poll: process.env.CHOKIDAR_USEPOLLING === 'true' ? 3000 : false,
            ignored: /node_modules/,
        },
        module: {
            rules: [
                {
                    test: /\.tsx?$/,
                    use: [
                        {
                            loader: 'swc-loader',
                            options: {
                                jsc: {
                                    target: 'es2022',
                                    parser: {
                                        syntax: 'typescript',
                                        decorators: true,
                                        dynamicImport: true,
                                    },
                                    transform: {
                                        legacyDecorator: true,
                                        decoratorMetadata: true,
                                    },
                                    keepClassNames: true,
                                },
                            },
                        },
                    ],
                    exclude: /node_modules/,
                },
            ],
        },
    };
};
