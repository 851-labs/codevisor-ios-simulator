#import <AVFoundation/AVFoundation.h>
#import <FBControlCore/FBControlCore.h>
#import <FBSimulatorControl/FBSimulatorControl.h>
#import <Foundation/Foundation.h>
#import <XPC/XPC.h>
#import <dlfcn.h>
#import <errno.h>
#import <limits.h>
#import <mach/mach.h>
#import <math.h>
#import <poll.h>
#import <stdlib.h>
#import <string.h>
#import <sys/socket.h>
#import <sys/stat.h>
#import <sys/un.h>
#import <sysexits.h>
#import <time.h>
#import <unistd.h>

static NSString *const DigitizerService = @"com.apple.coredevice.feature.remote.hid.digitizer";
static const NSUInteger MaximumMessageBytes = 64 * 1024;
static const uint64_t GestureLeaseNanoseconds = 30ULL * NSEC_PER_SEC;
static const uint64_t IdleTimeoutNanoseconds = 60ULL * NSEC_PER_SEC;
static const int ClientTimeoutMilliseconds = 2000;
static const int XPCBarrierTimeoutMilliseconds = 2000;

static NSError *BrokerError(NSString *message) {
  return [NSError errorWithDomain:@"com.851-labs.codevisor-ios-simulator.dtuhid"
                             code:1
                         userInfo:@{NSLocalizedDescriptionKey: message}];
}

static NSError *POSIXError(NSString *operation) {
  return BrokerError([NSString stringWithFormat:@"DTUHID broker %@ failed: %s", operation, strerror(errno)]);
}

static uint64_t MonotonicNow(void) {
  return clock_gettime_nsec_np(CLOCK_UPTIME_RAW);
}

@interface DTUHIDConnection : NSObject
- (nullable instancetype)initWithSimulatorUDID:(NSString *)simulatorUDID error:(NSError **)error;
- (BOOL)sendX:(double)x
            y:(double)y
    eventType:(uint64_t)eventType
         edge:(uint64_t)edge
        error:(NSError **)error;
@end

@implementation DTUHIDConnection {
  xpc_connection_t _connection;
  NSString *_connectionFailure;
}

typedef xpc_object_t _Nullable (*EndpointFromMachPortFn)(mach_port_t, uint64_t, uint64_t);
typedef xpc_connection_t _Nullable (*ConnectionFromEndpointFn)(xpc_object_t);
typedef void (*EnableSimulatorToHostFn)(xpc_connection_t);

- (nullable instancetype)initWithSimulatorUDID:(NSString *)simulatorUDID error:(NSError **)error {
  self = [super init];
  if (!self) {
    return nil;
  }

  if (![[FBSimulatorControlFrameworkLoader xcodeFrameworks] loadPrivateFrameworks:nil error:error]) {
    return nil;
  }
  FBSimulatorControlConfiguration *configuration =
      [FBSimulatorControlConfiguration configurationWithDeviceSetPath:nil logger:nil reporter:nil];
  FBSimulatorControl *control = [FBSimulatorControl withConfiguration:configuration error:error];
  if (!control) {
    return nil;
  }

  FBSimulator *simulator = nil;
  for (FBSimulator *candidate in control.set.allSimulators) {
    if ([candidate.udid isEqualToString:simulatorUDID]) {
      simulator = candidate;
      break;
    }
  }
  if (!simulator) {
    if (error) *error = BrokerError([NSString stringWithFormat:@"Simulator %@ was not found.", simulatorUDID]);
    return nil;
  }
  if (simulator.state != FBiOSTargetStateBooted) {
    if (error) *error = BrokerError([NSString stringWithFormat:@"Simulator %@ is not booted.", simulatorUDID]);
    return nil;
  }

  void *handle = dlopen(NULL, RTLD_NOW);
  EndpointFromMachPortFn endpointFromPort = handle ? (EndpointFromMachPortFn)dlsym(handle, "xpc_endpoint_create_mach_port_4sim") : NULL;
  ConnectionFromEndpointFn connectionFromEndpoint = handle ? (ConnectionFromEndpointFn)dlsym(handle, "xpc_connection_create_from_endpoint") : NULL;
  EnableSimulatorToHostFn enableSimulatorToHost = handle ? (EnableSimulatorToHostFn)dlsym(handle, "xpc_connection_enable_sim2host_4sim") : NULL;
  if (!endpointFromPort || !connectionFromEndpoint || !enableSimulatorToHost) {
    if (error) *error = BrokerError(@"The selected macOS/Xcode does not expose the simulator DTUHID XPC functions.");
    return nil;
  }

  NSNumber *servicePortNumber = [simulator lookupBootstrapPortNamed:DigitizerService error:error];
  mach_port_t servicePort = servicePortNumber.unsignedIntValue;
  xpc_object_t endpoint = servicePort ? endpointFromPort(servicePort, 0, 0) : nil;
  _connection = endpoint ? connectionFromEndpoint(endpoint) : nil;
  if (!_connection) {
    if (error && !*error) *error = BrokerError(@"Could not connect to the simulator DTUHID digitizer service.");
    return nil;
  }

  enableSimulatorToHost(_connection);
  __weak DTUHIDConnection *weakSelf = self;
  xpc_connection_set_event_handler(_connection, ^(xpc_object_t event) {
    if (xpc_get_type(event) != XPC_TYPE_ERROR) return;
    char *rawDescription = xpc_copy_description(event);
    NSString *description = rawDescription ? [NSString stringWithUTF8String:rawDescription] : @"unknown XPC error";
    free(rawDescription);
    DTUHIDConnection *strongSelf = weakSelf;
    if (!strongSelf) return;
    @synchronized (strongSelf) {
      strongSelf->_connectionFailure = description;
    }
  });
  xpc_connection_resume(_connection);
  return self;
}

- (void)dealloc {
  if (_connection) xpc_connection_cancel(_connection);
}

- (nullable NSString *)connectionFailure {
  @synchronized (self) {
    return _connectionFailure;
  }
}

- (BOOL)sendX:(double)x
            y:(double)y
    eventType:(uint64_t)eventType
         edge:(uint64_t)edge
        error:(NSError **)error {
  NSString *failure = self.connectionFailure;
  if (failure) {
    if (error) *error = BrokerError([NSString stringWithFormat:@"The simulator DTUHID connection closed: %@", failure]);
    return NO;
  }

  xpc_object_t point = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_double(point, "x", x);
  xpc_dictionary_set_double(point, "y", y);

  xpc_object_t payload = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_value(payload, "pointOne", point);
  xpc_dictionary_set_uint64(payload, "eventType", eventType);
  xpc_dictionary_set_uint64(payload, "edge", edge);
  xpc_dictionary_set_uint64(payload, "target", 0);

  xpc_object_t message = xpc_dictionary_create(NULL, NULL, 0);
  xpc_dictionary_set_string(message, "messageType", "IndigoDigitizerEvent");
  xpc_dictionary_set_bool(message, "isBarrier", false);
  xpc_dictionary_set_string(message, "featureIdentifier", DigitizerService.UTF8String);
  xpc_dictionary_set_value(message, "payload", payload);

  dispatch_semaphore_t barrier = dispatch_semaphore_create(0);
  xpc_connection_send_message(_connection, message);
  xpc_connection_send_barrier(_connection, ^{
    dispatch_semaphore_signal(barrier);
  });
  dispatch_time_t deadline = dispatch_time(DISPATCH_TIME_NOW, (int64_t)XPCBarrierTimeoutMilliseconds * NSEC_PER_MSEC);
  if (dispatch_semaphore_wait(barrier, deadline) != 0) {
    if (error) *error = BrokerError(@"Timed out sending a touch to the simulator DTUHID service.");
    return NO;
  }

  failure = self.connectionFailure;
  if (failure) {
    if (error) *error = BrokerError([NSString stringWithFormat:@"The simulator DTUHID connection closed: %@", failure]);
    return NO;
  }
  return YES;
}

@end

@interface ActiveGesture : NSObject
@property(nonatomic, copy) NSString *owner;
@property(nonatomic, assign) uint64_t edge;
@property(nonatomic, assign) double x;
@property(nonatomic, assign) double y;
@property(nonatomic, assign) uint64_t lastEventAt;
@end

@implementation ActiveGesture
@end

@interface GestureBroker : NSObject
@property(nonatomic, readonly) int32_t nextWakeupMilliseconds;
@property(nonatomic, readonly) BOOL hasActiveGesture;
- (nullable instancetype)initWithSimulatorUDID:(NSString *)simulatorUDID error:(NSError **)error;
- (BOOL)handleRequest:(NSDictionary *)request error:(NSError **)error;
- (BOOL)expireGestureIfNeeded:(NSError **)error;
- (void)releaseActiveGesture;
@end

@implementation GestureBroker {
  DTUHIDConnection *_hid;
  ActiveGesture *_active;
}

- (nullable instancetype)initWithSimulatorUDID:(NSString *)simulatorUDID error:(NSError **)error {
  self = [super init];
  if (!self) return nil;
  _hid = [[DTUHIDConnection alloc] initWithSimulatorUDID:simulatorUDID error:error];
  return _hid ? self : nil;
}

- (BOOL)hasActiveGesture {
  return _active != nil;
}

- (int32_t)nextWakeupMilliseconds {
  if (!_active) return (int32_t)(IdleTimeoutNanoseconds / NSEC_PER_MSEC);
  uint64_t now = MonotonicNow();
  uint64_t deadline = _active.lastEventAt + GestureLeaseNanoseconds;
  if (deadline < _active.lastEventAt || deadline <= now) return 0;
  uint64_t milliseconds = (deadline - now) / NSEC_PER_MSEC;
  return (int32_t)MIN(milliseconds, (uint64_t)INT32_MAX);
}

- (BOOL)expireGestureIfNeeded:(NSError **)error {
  if (!_active || MonotonicNow() - _active.lastEventAt < GestureLeaseNanoseconds) return YES;
  BOOL sent = [_hid sendX:_active.x y:_active.y eventType:2 edge:_active.edge error:error];
  _active = nil;
  return sent;
}

- (BOOL)handleRequest:(NSDictionary *)request error:(NSError **)error {
  if (![self expireGestureIfNeeded:error]) return NO;
  NSDictionary *touch = [request[@"touch"] isKindOfClass:NSDictionary.class] ? request[@"touch"] : nil;
  if (!touch) {
    if ([request[@"ping"] boolValue]) return YES;
    if (error) *error = BrokerError(@"The DTUHID broker request is empty.");
    return NO;
  }

  NSString *owner = [request[@"gesture"] isKindOfClass:NSString.class] ? request[@"gesture"] : nil;
  NSString *phase = [touch[@"type"] isKindOfClass:NSString.class] ? touch[@"type"] : nil;
  NSNumber *xNumber = [touch[@"x"] isKindOfClass:NSNumber.class] ? touch[@"x"] : nil;
  NSNumber *yNumber = [touch[@"y"] isKindOfClass:NSNumber.class] ? touch[@"y"] : nil;
  if (!owner.length || [owner lengthOfBytesUsingEncoding:NSUTF8StringEncoding] > 128) {
    if (error) *error = BrokerError(@"The touch gesture identifier is missing or invalid.");
    return NO;
  }
  double x = xNumber.doubleValue;
  double y = yNumber.doubleValue;
  if (!xNumber || !yNumber || !isfinite(x) || !isfinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    if (error) *error = BrokerError(@"Touch coordinates must be normalized between 0 and 1.");
    return NO;
  }

  if ([phase isEqualToString:@"begin"]) {
    if (_active) {
      if (error) {
        *error = BrokerError([_active.owner isEqualToString:owner]
                                 ? @"This gesture is already active."
                                 : @"Another Codevisor session is controlling this simulator.");
      }
      return NO;
    }
    NSNumber *edgeNumber = [touch[@"edge"] isKindOfClass:NSNumber.class] ? touch[@"edge"] : nil;
    uint64_t edge = edgeNumber.unsignedLongLongValue;
    if (edge > 4) {
      if (error) *error = BrokerError(@"Touch edge must be between 0 and 4.");
      return NO;
    }
    if (![_hid sendX:x y:y eventType:0 edge:edge error:error]) return NO;
    _active = [ActiveGesture new];
    _active.owner = owner;
    _active.edge = edge;
    _active.x = x;
    _active.y = y;
    _active.lastEventAt = MonotonicNow();
    return YES;
  }

  if ([phase isEqualToString:@"move"]) {
    if (!_active || ![_active.owner isEqualToString:owner]) {
      if (error) *error = BrokerError(@"This Codevisor session does not own the active simulator gesture.");
      return NO;
    }
    if (![_hid sendX:x y:y eventType:1 edge:_active.edge error:error]) return NO;
    _active.x = x;
    _active.y = y;
    _active.lastEventAt = MonotonicNow();
    return YES;
  }

  if ([phase isEqualToString:@"end"]) {
    if (!_active) return YES;
    if (![_active.owner isEqualToString:owner]) {
      if (error) *error = BrokerError(@"This Codevisor session does not own the active simulator gesture.");
      return NO;
    }
    BOOL sent = [_hid sendX:x y:y eventType:2 edge:_active.edge error:error];
    _active = nil;
    return sent;
  }

  if (error) *error = BrokerError(@"Touch type must be begin, move, or end.");
  return NO;
}

- (void)releaseActiveGesture {
  if (!_active) return;
  [_hid sendX:_active.x y:_active.y eventType:2 edge:_active.edge error:nil];
  _active = nil;
}

@end

typedef struct {
  dev_t device;
  ino_t inode;
} SocketIdentity;

static BOOL SocketIdentityAtPath(NSString *path, SocketIdentity *identity, NSError **error) {
  struct stat info;
  if (lstat(path.fileSystemRepresentation, &info) != 0) {
    if (error) *error = POSIXError(@"lstat");
    return NO;
  }
  if ((info.st_mode & S_IFMT) != S_IFSOCK || info.st_uid != getuid()) {
    if (error) *error = BrokerError(@"The DTUHID broker socket is not owned by the current user.");
    return NO;
  }
  identity->device = info.st_dev;
  identity->inode = info.st_ino;
  return YES;
}

static BOOL SameSocketIdentity(SocketIdentity first, SocketIdentity second) {
  return first.device == second.device && first.inode == second.inode;
}

static BOOL MakeAddress(NSString *path, struct sockaddr_un *address, NSError **error) {
  NSData *bytes = [path dataUsingEncoding:NSUTF8StringEncoding];
  if (bytes.length + 1 > sizeof(address->sun_path)) {
    if (error) *error = BrokerError(@"The DTUHID broker socket path is too long.");
    return NO;
  }
  memset(address, 0, sizeof(*address));
  address->sun_family = AF_UNIX;
  address->sun_len = sizeof(*address);
  memcpy(address->sun_path, bytes.bytes, bytes.length);
  return YES;
}

static int MakeListener(NSString *path, SocketIdentity *identity, NSError **error) {
  NSString *parent = path.stringByDeletingLastPathComponent;
  struct stat parentInfo;
  if (lstat(parent.fileSystemRepresentation, &parentInfo) != 0 ||
      (parentInfo.st_mode & S_IFMT) != S_IFDIR ||
      parentInfo.st_uid != getuid() ||
      (parentInfo.st_mode & (S_IRWXG | S_IRWXO)) != 0) {
    if (error) *error = BrokerError(@"The DTUHID broker directory must be private and owned by the current user.");
    return -1;
  }

  int descriptor = socket(AF_UNIX, SOCK_STREAM, 0);
  if (descriptor < 0) {
    if (error) *error = POSIXError(@"socket");
    return -1;
  }
  int noSignal = 1;
  setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, sizeof(noSignal));
  struct sockaddr_un address;
  if (!MakeAddress(path, &address, error) ||
      bind(descriptor, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      chmod(path.fileSystemRepresentation, S_IRUSR | S_IWUSR) != 0 ||
      listen(descriptor, SOMAXCONN) != 0) {
    if (error && !*error) *error = POSIXError(@"bind/listen");
    close(descriptor);
    return -1;
  }
  if (!SocketIdentityAtPath(path, identity, error)) {
    close(descriptor);
    return -1;
  }
  return descriptor;
}

static void ConfigureClient(int descriptor) {
  int noSignal = 1;
  setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, sizeof(noSignal));
  struct timeval timeout = {
      .tv_sec = ClientTimeoutMilliseconds / 1000,
      .tv_usec = (ClientTimeoutMilliseconds % 1000) * 1000,
  };
  setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
}

static NSData *ReadMessage(int descriptor, NSError **error) {
  NSMutableData *data = [NSMutableData data];
  uint8_t buffer[4096];
  while (data.length <= MaximumMessageBytes) {
    ssize_t count = read(descriptor, buffer, sizeof(buffer));
    if (count < 0) {
      if (errno == EINTR) continue;
      if (error) *error = POSIXError(@"read");
      return nil;
    }
    if (count == 0) break;
    void *newline = memchr(buffer, '\n', (size_t)count);
    if (newline) {
      [data appendBytes:buffer length:(NSUInteger)((uint8_t *)newline - buffer)];
      return data;
    }
    [data appendBytes:buffer length:(NSUInteger)count];
  }
  if (error) *error = BrokerError(@"The DTUHID broker request is missing or too large.");
  return nil;
}

static BOOL WriteJSONObject(id object, int descriptor, NSError **error) {
  NSMutableData *data = [[NSJSONSerialization dataWithJSONObject:object options:0 error:error] mutableCopy];
  if (!data) return NO;
  uint8_t newline = '\n';
  [data appendBytes:&newline length:1];
  const uint8_t *bytes = data.bytes;
  NSUInteger offset = 0;
  while (offset < data.length) {
    ssize_t count = write(descriptor, bytes + offset, data.length - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      if (error) *error = POSIXError(@"write");
      return NO;
    }
    offset += (NSUInteger)count;
  }
  return YES;
}

static void ProcessClient(int descriptor, GestureBroker *broker) {
  ConfigureClient(descriptor);
  NSError *error = nil;
  if (!WriteJSONObject(@{@"ready": @YES}, descriptor, &error)) return;
  NSData *data = ReadMessage(descriptor, &error);
  NSDictionary *request = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
  if (request && ![request isKindOfClass:NSDictionary.class]) {
    error = BrokerError(@"The DTUHID broker request must be a JSON object.");
    request = nil;
  }
  if (request && ![broker handleRequest:request error:&error]) request = nil;
  WriteJSONObject(@{@"error": error.localizedDescription ?: NSNull.null}, descriptor, nil);
}

static NSString *Argument(NSString *name) {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  NSUInteger index = [arguments indexOfObject:name];
  if (index == NSNotFound || index + 1 >= arguments.count) return nil;
  return arguments[index + 1];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *simulatorUDID = Argument(@"--udid");
    NSString *socketPath = Argument(@"--socket");
    if (!simulatorUDID || !socketPath) {
      fprintf(stderr, "Usage: codevisor-dtuhid-broker --udid <UDID> --socket <path>\n");
      return EX_USAGE;
    }

    NSError *error = nil;
    GestureBroker *broker = [[GestureBroker alloc] initWithSimulatorUDID:simulatorUDID error:&error];
    if (!broker) {
      fprintf(stderr, "codevisor-dtuhid-broker: %s\n", error.localizedDescription.UTF8String);
      return EXIT_FAILURE;
    }
    SocketIdentity identity;
    int listener = MakeListener(socketPath, &identity, &error);
    if (listener < 0) {
      fprintf(stderr, "codevisor-dtuhid-broker: %s\n", error.localizedDescription.UTF8String);
      return EXIT_FAILURE;
    }

    uint64_t lastClientAt = MonotonicNow();
    int exitCode = EXIT_SUCCESS;
    while (true) {
      struct pollfd descriptor = {.fd = listener, .events = POLLIN, .revents = 0};
      int result = poll(&descriptor, 1, broker.nextWakeupMilliseconds);
      if (result < 0) {
        if (errno == EINTR) continue;
        error = POSIXError(@"poll");
        exitCode = EXIT_FAILURE;
        break;
      }
      if (result == 0) {
        if (![broker expireGestureIfNeeded:&error]) {
          exitCode = EXIT_FAILURE;
          break;
        }
        if (!broker.hasActiveGesture && MonotonicNow() - lastClientAt >= IdleTimeoutNanoseconds) break;
        continue;
      }

      int client = accept(listener, NULL, NULL);
      if (client < 0) {
        if (errno == EINTR) continue;
        error = POSIXError(@"accept");
        exitCode = EXIT_FAILURE;
        break;
      }
      lastClientAt = MonotonicNow();
      ProcessClient(client, broker);
      close(client);
    }

    [broker releaseActiveGesture];
    usleep(80000);
    close(listener);
    SocketIdentity currentIdentity;
    if (SocketIdentityAtPath(socketPath, &currentIdentity, nil) && SameSocketIdentity(identity, currentIdentity)) {
      unlink(socketPath.fileSystemRepresentation);
    }
    if (error) fprintf(stderr, "codevisor-dtuhid-broker: %s\n", error.localizedDescription.UTF8String);
    return exitCode;
  }
}
