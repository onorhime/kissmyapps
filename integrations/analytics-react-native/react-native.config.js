// Autolinking for the optional native module KissMyAppsAttribution (React Native CLI and
// Expo prebuild). iOS finds KissMyAppsReactNative.podspec on its own.
module.exports = {
  dependency: {
    platforms: {
      android: {
        sourceDir: './android',
        packageImportPath: 'import com.kissmyapps.reactnative.KissMyAppsAttributionPackage;',
        packageInstance: 'new KissMyAppsAttributionPackage()',
      },
    },
  },
}
