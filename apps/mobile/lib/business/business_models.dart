/// Businesses, their catalogue, orders and bookings as the API returns them. Prices are in
/// minor units (cents); totals are always worked out by the server.
library;

class Business {
  Business({
    required this.id,
    required this.handle,
    required this.name,
    required this.description,
    required this.category,
    required this.address,
    required this.timeZone,
    required this.currency,
    required this.ordersEnabled,
    required this.bookingsEnabled,
    required this.verified,
  });
  factory Business.fromJson(Map<String, dynamic> j) => Business(
        id: j['id'] as String,
        handle: j['handle'] as String,
        name: j['name'] as String,
        description: j['description'] as String? ?? '',
        category: j['category'] as String,
        address: j['address'] as String? ?? '',
        timeZone: j['timeZone'] as String,
        currency: j['currency'] as String,
        ordersEnabled: j['ordersEnabled'] as bool,
        bookingsEnabled: j['bookingsEnabled'] as bool,
        verified: j['verified'] as bool? ?? false,
      );
  final String id;
  final String handle;
  final String name;
  final String description;
  final String category;
  final String address;
  final String timeZone;
  final String currency;
  final bool ordersEnabled;
  final bool bookingsEnabled;
  final bool verified;
}

class CatalogueItem {
  CatalogueItem({required this.id, required this.name, required this.description, required this.priceMinor, required this.currency, required this.available});
  factory CatalogueItem.fromJson(Map<String, dynamic> j) => CatalogueItem(
        id: j['id'] as String,
        name: j['name'] as String,
        description: j['description'] as String? ?? '',
        priceMinor: (j['priceMinor'] as num).toInt(),
        currency: j['currency'] as String,
        available: j['available'] as bool,
      );
  final String id;
  final String name;
  final String description;
  final int priceMinor;
  final String currency;
  final bool available;
}

class BookableService {
  BookableService({required this.id, required this.name, required this.durationMinutes, required this.priceMinor, required this.currency});
  factory BookableService.fromJson(Map<String, dynamic> j) => BookableService(
        id: j['id'] as String,
        name: j['name'] as String,
        durationMinutes: (j['durationMinutes'] as num).toInt(),
        priceMinor: (j['priceMinor'] as num).toInt(),
        currency: j['currency'] as String,
      );
  final String id;
  final String name;
  final int durationMinutes;
  final int priceMinor;
  final String currency;
}

class Slot {
  Slot({required this.startsAt, required this.endsAt});
  factory Slot.fromJson(Map<String, dynamic> j) => Slot(startsAt: DateTime.parse(j['startsAt'] as String), endsAt: DateTime.parse(j['endsAt'] as String));
  final DateTime startsAt;
  final DateTime endsAt;
}

const orderStatusLabels = {
  'placed': 'Waiting for the business',
  'accepted': 'Being prepared',
  'ready': 'Ready to collect',
  'completed': 'Collected',
  'cancelled': 'Cancelled',
  'rejected': 'Declined',
};

class OrderLine {
  OrderLine({required this.name, required this.unitPriceMinor, required this.quantity});
  final String name;
  final int unitPriceMinor;
  final int quantity;
}

class Order {
  Order({required this.id, required this.businessName, required this.status, required this.statusReason, required this.lines, required this.totalMinor, required this.currency});
  factory Order.fromJson(Map<String, dynamic> j) => Order(
        id: j['id'] as String,
        businessName: (j['business'] as Map<String, dynamic>)['name'] as String,
        status: j['status'] as String,
        statusReason: j['statusReason'] as String? ?? '',
        lines: [
          for (final i in j['items'] as List)
            OrderLine(name: (i as Map<String, dynamic>)['name'] as String, unitPriceMinor: (i['unitPriceMinor'] as num).toInt(), quantity: (i['quantity'] as num).toInt()),
        ],
        totalMinor: (j['totalMinor'] as num).toInt(),
        currency: j['currency'] as String,
      );
  final String id;
  final String businessName;
  final String status;
  final String statusReason;
  final List<OrderLine> lines;
  final int totalMinor;
  final String currency;
}

class Booking {
  Booking({required this.id, required this.businessName, required this.serviceName, required this.startsAt, required this.status, this.cancelledBy});
  factory Booking.fromJson(Map<String, dynamic> j) => Booking(
        id: j['id'] as String,
        businessName: (j['business'] as Map<String, dynamic>)['name'] as String,
        serviceName: (j['service'] as Map<String, dynamic>)['name'] as String,
        startsAt: DateTime.parse(j['startsAt'] as String),
        status: j['status'] as String,
        cancelledBy: j['cancelledBy'] as String?,
      );
  final String id;
  final String businessName;
  final String serviceName;
  final DateTime startsAt;
  final String status;
  final String? cancelledBy;
}

/// Currencies with no minor unit, so 500 means 500, not 5.00.
const _zeroDecimal = {'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF', 'PYG', 'RWF'};

String formatMoney(int minor, String currency) {
  if (_zeroDecimal.contains(currency)) return '$currency $minor';
  final whole = minor ~/ 100;
  final cents = (minor % 100).toString().padLeft(2, '0');
  return '$currency $whole.$cents';
}

/// YYYY-MM-DD, as the slots endpoint expects.
String isoDate(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

String hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
