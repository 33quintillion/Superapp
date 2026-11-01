import 'package:geolocator/geolocator.dart';

/// Where the phone is, for sharing a location in a chat. Tests swap in [LocationSource.instance].
abstract class LocationSource {
  static LocationSource instance = PlatformLocationSource();

  /// The current position, or null if location is off or the person said no.
  Future<({double lat, double lng})?> current();
}

class PlatformLocationSource implements LocationSource {
  @override
  Future<({double lat, double lng})?> current() async {
    if (!await Geolocator.isLocationServiceEnabled()) return null;
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) permission = await Geolocator.requestPermission();
    if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) return null;
    final p = await Geolocator.getCurrentPosition(locationSettings: const LocationSettings(accuracy: LocationAccuracy.high, timeLimit: Duration(seconds: 20)));
    return (lat: _round(p.latitude), lng: _round(p.longitude));
  }
}

double _round(double x) => (x * 1e6).roundToDouble() / 1e6;
