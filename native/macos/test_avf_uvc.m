// Test: does AVFoundation on macOS Tahoe expose UVC controls natively?
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMediaIO/CoreMediaIO.h>
#include <stdio.h>

int main() {
    @autoreleasepool {
        // List all external cameras
        AVCaptureDeviceDiscoverySession *session = [AVCaptureDeviceDiscoverySession
            discoverySessionWithDeviceTypes:@[AVCaptureDeviceTypeExternal]
                                  mediaType:AVMediaTypeVideo
                                   position:AVCaptureDevicePositionUnspecified];
        printf("Found %lu external cameras\n", (unsigned long)session.devices.count);
        
        for (AVCaptureDevice *dev in session.devices) {
            printf("\n--- Camera: %s (UID: %s) ---\n", 
                   [dev.localizedName UTF8String], [dev.uniqueID UTF8String]);
            
            // Check if there are format-level controls
            for (AVCaptureDeviceFormat *fmt in dev.formats) {
                printf("  Format: %s\n", [[fmt description] UTF8String]);
                
                // For the first format, check custom UVC controls
                if (fmt == dev.activeFormat || fmt == dev.formats.firstObject) {
                    NSArray *formatControls = [fmt valueForKey:@"supportedControls"];
                    if (formatControls) {
                        printf("    supportedControls: %s\n", [[formatControls description] UTF8String]);
                    }
                    
                    // Check UVC extension units
                    id uvcUnits = [fmt valueForKey:@"UVCExtensionUnits"];
                    if (uvcUnits) {
                        printf("    UVCExtensionUnits: %s\n", [[uvcUnits description] UTF8String]);
                    }
                    
                    id xuControls = [fmt valueForKey:@"XUControls"];
                    if (xuControls) {
                        printf("    XUControls: %s\n", [[xuControls description] UTF8String]);
                    }
                }
            }
            
            // Check device-level UVC properties
            printf("  device.controls: %s\n", [[[dev valueForKey:@"controls"] description] UTF8String]);
            
            // Try to see if there are extension unit dictionaries
            // These are sometimes exposed via private API
            SEL sel = NSSelectorFromString(@"UVCDeviceControls");
            if ([dev respondsToSelector:sel]) {
                id uvcControls = ((id (*)(id, SEL))[dev methodForSelector:sel])(dev, sel);
                printf("  UVCDeviceControls: %s\n", [[uvcControls description] UTF8String]);
            }
            
            sel = NSSelectorFromString(@"extensionUnits");
            if ([dev respondsToSelector:sel]) {
                id extUnits = ((id (*)(id, SEL))[dev methodForSelector:sel])(dev, sel);
                printf("  extensionUnits: %s\n", [[extUnits description] UTF8String]);
            }
        }
        
        // Also check CoreMediaIO
        printf("\n--- CoreMediaIO ---\n");
        CMIOObjectPropertyAddress addr = {
            kCMIOHardwarePropertyDevices,
            kCMIOObjectPropertyScopeGlobal,
            kCMIOObjectPropertyElementMain
        };
        UInt32 dataSize = 0;
        CMIOObjectGetPropertyDataSize(kCMIOObjectSystemObject, &addr, 0, NULL, &dataSize);
        printf("CMIO devices data size: %u\n", (unsigned)dataSize);
        if (dataSize > 0) {
            UInt32 count = dataSize / sizeof(CMIODeviceID);
            CMIODeviceID *devices = malloc(dataSize);
            CMIOObjectGetPropertyData(kCMIOObjectSystemObject, &addr, 0, NULL, dataSize, &dataSize, devices);
            for (UInt32 i = 0; i < count; i++) {
                CMIODeviceID devId = devices[i];
                CFStringRef name = NULL;
                addr.mSelector = kCMIODevicePropertyDeviceUID;
                UInt32 nameSize = sizeof(CFStringRef);
                CMIOObjectGetPropertyData(devId, &addr, 0, NULL, nameSize, &nameSize, &name);
                printf("  CMIO Device: %s\n", name ? [(__bridge NSString*)name UTF8String] : "?");
                if (name) CFRelease(name);
            }
            free(devices);
        }
    }
    return 0;
}
