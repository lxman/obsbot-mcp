#import <Foundation/Foundation.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/IOCFPlugIn.h>
#import <IOKit/usb/IOUSBLib.h>
#import <IOKit/usb/USBSpec.h>

int main() {
    @autoreleasepool {
        CFMutableDictionaryRef matching = IOServiceMatching(kIOUSBDeviceClassName);
        uint32_t v = 0x3564, p = 0xFEF8;
        CFNumberRef vidNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &v);
        CFNumberRef pidNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &p);
        CFDictionarySetValue(matching, CFSTR("idVendor"), vidNum);
        CFDictionarySetValue(matching, CFSTR("idProduct"), pidNum);
        CFRelease(vidNum); CFRelease(pidNum);
        
        io_iterator_t iter = 0;
        IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iter);
        io_service_t service = IOIteratorNext(iter);
        IOObjectRelease(iter);
        
        if (!service) { fprintf(stderr, "No device found\n"); return 1; }
        fprintf(stderr, "Device service: %u\n", service);
        
        // Walk children recursively
        io_iterator_t childIter = 0;
        IOReturn kr = IORegistryEntryCreateIterator(service, kIOServicePlane, kIORegistryIterateRecursively, &childIter);
        fprintf(stderr, "CreateIterator: 0x%x, iter=%p\n", kr, (void*)childIter);
        
        io_service_t child;
        int idx = 0;
        while ((child = IOIteratorNext(childIter))) {
            CFMutableDictionaryRef props = NULL;
            kr = IORegistryEntryCreateCFProperties(child, &props, kCFAllocatorDefault, kNilOptions);
            fprintf(stderr, "Child %d: kr=0x%x props=%p\n", idx++, kr, (void*)props);
            if (kr == kIOReturnSuccess && props) {
                NSDictionary *dict = (__bridge NSDictionary *)props;
                fprintf(stderr, "  name in tree: %s\n", [[dict objectForKey:@"name"] UTF8String] ?: "nil");
                fprintf(stderr, "  bInterfaceClass: %@\n", [dict objectForKey:@"bInterfaceClass"]);
                fprintf(stderr, "  bInterfaceSubClass: %@\n", [dict objectForKey:@"bInterfaceSubClass"]);
                
                // Also dump all keys
                NSArray *keys = [dict allKeys];
                for (NSString *key in keys) {
                    id val = [dict objectForKey:key];
                    fprintf(stderr, "  key='%s' val=%s\n", [key UTF8String], [[val description] UTF8String]);
                }
                CFRelease(props);
            }
            IOObjectRelease(child);
        }
        IOObjectRelease(childIter);
        
        // Now try the specific UVC interface
        // The camera interface shows in ioreg as "OBSBOT Tiny 2 StreamCamera@0"
        // Let's also look at IOCreatePlugInInterfaceForService on the KEXT plane
        IOObjectRelease(service);
    }
    return 0;
}
