// Files and HTTP from dart:io on Android and iOS; on the web there is nothing to use.
export 'stub.dart' if (dart.library.io) 'io.dart';
