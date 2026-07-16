// Diagnostic helper: test USB device enumeration and opening
#import <Foundation/Foundation.h>
#import <IOKit/IOKitLib.h>
#import <IOKit/IOCFPlugIn.h>
#import <IOKit/usb/IOUSBLib.h>
#import <IOKit/usb/USBSpec.h>

static NSString *usbStringDescriptor(IOUSBDeviceInterface **device, uint8_t index) {
    if (!device || index == 0) return nil;
    IOUSBDevRequest req = {0};
    UInt8 buf[512];
    req.bmRequestType = USBmakebmRequestType(kUSBIn, kUSBStandard, kUSBDevice);
    req.bRequest      = kUSBRqGetDescriptor;
    req.wValue        = (kUSBStringDesc << 8) | index;
    req.wIndex        = 0;
    req.wLength       = sizeof(buf);
    req.pData         = buf;
    IOReturn kr = (*device)->DeviceRequest(device, &req);
    if (kr != kIOReturnSuccess) { fprintf(stderr, "string descriptor %d failed: 0x%x\n", index, kr); return nil; }
    UInt16 len = buf[0];
    if (len < 2) return nil;
    return [[NSString alloc] initWithBytes:buf + 2 length:len - 2 encoding:NSUTF16LittleEndianStringEncoding];
}

static IOUSBDeviceInterface **openUsbDevice(io_service_t service) {
    IOCFPlugInInterface **plugIn = NULL;
    SInt32 score = 0;
    IOReturn kr = IOCreatePlugInInterfaceForService(service, kIOUSBDeviceUserClientTypeID,
                                                     kIOCFPlugInInterfaceID, &plugIn, &score);
    if (kr != kIOReturnSuccess || !plugIn) { fprintf(stderr, "  IOCreatePlugInInterfaceForService failed: 0x%x\n", kr); return NULL; }
    IOUSBDeviceInterface **device = NULL;
    HRESULT res = (*plugIn)->QueryInterface(plugIn, CFUUIDGetUUIDBytes(kIOUSBDeviceInterfaceID), (LPVOID *)&device);
    (*plugIn)->Release(plugIn);
    if (res != S_OK || !device) { fprintf(stderr, "  QueryInterface failed: 0x%x\n", (unsigned)res); return NULL; }
    kr = (*device)->USBDeviceOpen(device);
    if (kr != kIOReturnSuccess) { fprintf(stderr, "  USBDeviceOpen failed: 0x%x\n", kr); (*device)->Release(device); return NULL; }
    return device;
}

static IOUSBInterfaceInterface **findUvcInterface(IOUSBDeviceInterface **device) {
    IOUSBFindInterfaceRequest req = {
        .bInterfaceClass    = 0x0E,
        .bInterfaceSubClass = 0x01,
        .bInterfaceProtocol = kIOUSBFindInterfaceDontCare,
        .bAlternateSetting  = kIOUSBFindInterfaceDontCare,
    };
    io_iterator_t iter = 0;
    IOReturn kr = (*device)->CreateInterfaceIterator(device, &req, &iter);
    if (kr != kIOReturnSuccess || !iter) { fprintf(stderr, "  CreateInterfaceIterator failed: 0x%x\n", kr); return NULL; }
    io_service_t intfService;
    IOUSBInterfaceInterface **intf = NULL;
    if ((intfService = IOIteratorNext(iter))) {
        IOCFPlugInInterface **plugIn = NULL;
        SInt32 score = 0;
        kr = IOCreatePlugInInterfaceForService(intfService, kIOUSBInterfaceUserClientTypeID,
                                                kIOCFPlugInInterfaceID, &plugIn, &score);
        if (kr == kIOReturnSuccess && plugIn) {
            HRESULT res = (*plugIn)->QueryInterface(plugIn, CFUUIDGetUUIDBytes(kIOUSBInterfaceInterfaceID), (LPVOID *)&intf);
            (*plugIn)->Release(plugIn);
            if (res == S_OK && intf) {
                kr = (*intf)->USBInterfaceOpen(intf);
                if (kr != kIOReturnSuccess) { (*intf)->Release(intf); intf = NULL; }
            }
        }
        IOObjectRelease(intfService);
    }
    IOObjectRelease(iter);
    return intf;
}

int main() {
    int found = 0;
    @autoreleasepool {
        // Test 1: kIOUSBDeviceClassName (the legacy constant the helper uses)
        fprintf(stderr, "--- Test 1: IOServiceMatching with kIOUSBDeviceClassName ---\n");

        CFMutableDictionaryRef matching = IOServiceMatching(kIOUSBDeviceClassName);
        if (!matching) { fprintf(stderr, "IOServiceMatching failed\n"); return 1; }

        uint32_t v32 = 0x3564, p32 = 0xFEF8;
        CFNumberRef vidNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &v32);
        CFNumberRef pidNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &p32);
        CFDictionarySetValue(matching, CFSTR("idVendor"), vidNum);
        CFDictionarySetValue(matching, CFSTR("idProduct"), pidNum);
        CFRelease(vidNum); CFRelease(pidNum);

        io_iterator_t iter = 0;
        IOReturn kr = IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iter);
        fprintf(stderr, "IOServiceGetMatchingServices: 0x%x, iter=%p\n", kr, (void*)iter);
        int count = 0;
        io_service_t service;
        while ((service = IOIteratorNext(iter))) {
            count++;
            fprintf(stderr, "  Matched service %d\n", count);
            IOUSBDeviceInterface **dev = openUsbDevice(service);
            if (dev) {
                NSString *manufacturer = usbStringDescriptor(dev, 1);
                NSString *product = usbStringDescriptor(dev, 2);
                NSString *serial = usbStringDescriptor(dev, 3);
                fprintf(stderr, "  manufacturer=%@, product=%@, serial=%@\n", manufacturer, product, serial);
                IOUSBInterfaceInterface **intf = findUvcInterface(dev);
                if (intf) {
                    fprintf(stderr, "  *** UVC interface FOUND, can do XU transfers! ***\n");
                    found = 1;
                    (*intf)->USBInterfaceClose(intf);
                    (*intf)->Release(intf);
                } else {
                    fprintf(stderr, "  No UVC interface\n");
                }
                (*dev)->USBDeviceClose(dev);
                (*dev)->Release(dev);
            }
            IOObjectRelease(service);
        }
        IOObjectRelease(iter);
        fprintf(stderr, "Total matches: %d\n", count);
        if (count == 0) {
            fprintf(stderr, "\n--- Test 2: Try with kCFNumberSInt16Type (original buggy code) ---\n");
            matching = IOServiceMatching(kIOUSBDeviceClassName);
            int16_t v16 = 0x3564, p16 = 0xFEF8;
            vidNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt16Type, &v16);
            pidNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt16Type, &p16);
            CFDictionarySetValue(matching, CFSTR("idVendor"), vidNum);
            CFDictionarySetValue(matching, CFSTR("idProduct"), pidNum);
            CFRelease(vidNum); CFRelease(pidNum);
            kr = IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iter);
            io_service_t s;
            int cnt2 = 0;
            while ((s = IOIteratorNext(iter))) { cnt2++; IOObjectRelease(s); }
            IOObjectRelease(iter);
            fprintf(stderr, "SInt16 matches: %d\n", cnt2);
        }
    }
    return found ? 0 : 1;
}
