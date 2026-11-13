// Registers the Swift module KissMyAppsAttribution with React Native.
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(KissMyAppsAttribution, NSObject)

RCT_EXTERN_METHOD(getAttributionInfo:(NSDictionary *)request
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
