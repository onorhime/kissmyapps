import '../client.dart';

/// No files to keep state in on this platform.
KmaStorage? fileStorage(String directory) => null;

/// No way to send on this platform; the SDK does not start here.
Future<KmaResponse> httpPost(Uri url, Map<String, String> headers, String body) {
  throw UnsupportedError('KissMyApps runs on Android and iOS.');
}
