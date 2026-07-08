const path = require('path')

module.exports = {
  target: 'node',
  entry: './src/index.ts',
  context: __dirname,
  mode: 'development',
  devtool: 'source-map',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    libraryTarget: 'umd',
    devtoolModuleFilenameTemplate: 'webpack-tabby-sftp-panel:///[resource-path]',
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [
      { test: /\.ts$/, use: { loader: 'ts-loader', options: { configFile: 'tsconfig.json', transpileOnly: true } } },
      // .po → { translations: {...} } object, same loader chain Tabby uses (see i18n.service.ts)
      { test: /\.po$/, use: [{ loader: 'json-loader' }, { loader: 'po-gettext-loader' }] },
    ],
  },
  externals: [
    'fs', 'path', 'os',
    /^@angular\//, /^@ng-bootstrap\//, 'rxjs', /^rxjs\//,
    /^tabby-/,
  ],
}
