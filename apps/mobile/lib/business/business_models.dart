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
    this.onlinePayments = false,
    this.inPersonPayments = true,
    this.myRole,
    this.permissions = const [],
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
        onlinePayments: (j['payments'] as Map<String, dynamic>?)?['online'] as bool? ?? false,
        inPersonPayments: (j['payments'] as Map<String, dynamic>?)?['inPerson'] as bool? ?? true,
        myRole: j['myRole'] as String?,
        permissions: [for (final p in j['permissions'] as List? ?? const []) p as String],
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

  /// The business has finished payout setup, so customers can pay by card when they order.
  final bool onlinePayments;
  final bool inPersonPayments;

  /// 'owner', 'manager' or 'staff' when you work here.
  final String? myRole;

  /// What you may do here, as the API decides it (for example 'orders.refund').
  final List<String> permissions;
  bool can(String permission) => permissions.contains(permission);
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
  BookableService({required this.id, required this.name, required this.durationMinutes, required this.priceMinor, required this.currency, this.depositMinor = 0, this.freeCancelHours = 24});
  factory BookableService.fromJson(Map<String, dynamic> j) => BookableService(
        id: j['id'] as String,
        name: j['name'] as String,
        durationMinutes: (j['durationMinutes'] as num).toInt(),
        priceMinor: (j['priceMinor'] as num).toInt(),
        currency: j['currency'] as String,
        depositMinor: (j['depositMinor'] as num?)?.toInt() ?? 0,
        freeCancelHours: (j['freeCancelHours'] as num?)?.toInt() ?? 24,
      );
  final String id;
  final String name;
  final int durationMinutes;
  final int priceMinor;
  final String currency;

  /// Paid by card when booking; 0 means everything is paid in person.
  final int depositMinor;
  final int freeCancelHours;
}

class Slot {
  Slot({required this.startsAt, required this.endsAt});
  factory Slot.fromJson(Map<String, dynamic> j) => Slot(startsAt: DateTime.parse(j['startsAt'] as String), endsAt: DateTime.parse(j['endsAt'] as String));
  final DateTime startsAt;
  final DateTime endsAt;
}

const orderStatusLabels = {
  'pending_payment': 'Waiting for payment',
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

/// What happened to an online payment. Orders paid at pickup have none.
const paymentStatusLabels = {
  'unpaid': 'Not paid yet',
  'paid': 'Paid online',
  'partially_refunded': 'Partly refunded',
  'refunded': 'Refunded',
  'cancelled': 'Payment cancelled',
};

class Order {
  Order({
    required this.id,
    required this.businessName,
    required this.status,
    required this.statusReason,
    required this.lines,
    required this.totalMinor,
    required this.currency,
    this.payment = 'pay_in_person',
    this.paymentStatus,
    this.refundedMinor = 0,
    this.customerName,
    this.note = '',
    this.createdAt,
  });
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
        payment: j['payment'] as String? ?? 'pay_in_person',
        paymentStatus: j['paymentStatus'] as String?,
        refundedMinor: (j['refundedMinor'] as num?)?.toInt() ?? 0,
        customerName: _customerName(j),
        note: j['note'] as String? ?? '',
        createdAt: j['createdAt'] == null ? null : DateTime.parse(j['createdAt'] as String),
      );
  final String id;
  final String businessName;
  final String status;
  final String statusReason;
  final List<OrderLine> lines;
  final int totalMinor;
  final String currency;

  /// 'online' or 'pay_in_person'.
  final String payment;
  final String? paymentStatus;
  final int refundedMinor;

  /// Staff lists only; null when the customer deleted their account.
  final String? customerName;
  final String note;
  final DateTime? createdAt;

  /// Paid online and not all refunded yet.
  bool get refundable => paymentStatus == 'paid' || paymentStatus == 'partially_refunded';

  /// How the order is being paid for, in words.
  String get paymentLabel {
    if (paymentStatus == null) return 'pay when you collect';
    final label = paymentStatusLabels[paymentStatus] ?? paymentStatus!;
    return refundedMinor > 0 && paymentStatus == 'partially_refunded' ? '$label (${formatMoney(refundedMinor, currency)} back)' : label;
  }
}

const bookingStatusLabels = {
  'pending_payment': 'Waiting for the deposit',
  'confirmed': 'Confirmed',
  'cancelled': 'Cancelled',
  'completed': 'Came',
  'no_show': 'Didn’t come',
};

/// A deposit paid by card when booking.
class Deposit {
  Deposit({required this.amountMinor, required this.status, required this.refundedMinor, required this.freeCancelUntil});
  factory Deposit.fromJson(Map<String, dynamic> j) => Deposit(
        amountMinor: (j['amountMinor'] as num).toInt(),
        status: j['status'] as String?,
        refundedMinor: (j['refundedMinor'] as num?)?.toInt() ?? 0,
        freeCancelUntil: j['freeCancelUntil'] == null ? null : DateTime.parse(j['freeCancelUntil'] as String),
      );
  final int amountMinor;

  /// A payment status ('paid', 'refunded'…), or null before checkout started.
  final String? status;
  final int refundedMinor;
  final DateTime? freeCancelUntil;
  bool get refundable => status == 'paid' || status == 'partially_refunded';
}

class Booking {
  Booking({
    required this.id,
    required this.businessName,
    required this.serviceName,
    required this.startsAt,
    required this.status,
    this.cancelledBy,
    this.customerName,
    this.note = '',
    this.currency = '',
    this.deposit,
  });
  factory Booking.fromJson(Map<String, dynamic> j) => Booking(
        id: j['id'] as String,
        businessName: (j['business'] as Map<String, dynamic>)['name'] as String,
        serviceName: (j['service'] as Map<String, dynamic>)['name'] as String,
        startsAt: DateTime.parse(j['startsAt'] as String),
        status: j['status'] as String,
        cancelledBy: j['cancelledBy'] as String?,
        customerName: _customerName(j),
        note: j['note'] as String? ?? '',
        currency: j['currency'] as String? ?? '',
        deposit: j['deposit'] == null ? null : Deposit.fromJson(j['deposit'] as Map<String, dynamic>),
      );
  final String id;
  final String businessName;
  final String serviceName;
  final DateTime startsAt;
  final String status;
  final String? cancelledBy;
  final String? customerName;
  final String note;
  final String currency;
  final Deposit? deposit;

  /// The deposit in words, or null when there is none.
  String? get depositLabel {
    final d = deposit;
    if (d == null || d.status == null) return null;
    final label = (paymentStatusLabels[d.status] ?? d.status!).toLowerCase();
    return 'Deposit ${formatMoney(d.amountMinor, currency)}: $label';
  }

  /// What happens to a paid deposit if the customer cancels now.
  String? cancellationNote(DateTime now) {
    final d = deposit;
    if (d == null || d.status != 'paid') return null;
    final until = d.freeCancelUntil;
    return until != null && until.isAfter(now)
        ? 'Cancel before ${isoDate(until.toLocal())} ${hhmm(until.toLocal())} to get your ${formatMoney(d.amountMinor, currency)} deposit back.'
        : 'If you cancel now, the business keeps your ${formatMoney(d.amountMinor, currency)} deposit.';
  }
}

String? _customerName(Map<String, dynamic> j) => j.containsKey('customer') ? ((j['customer'] as Map<String, dynamic>?)?['displayName'] as String? ?? 'Deleted account') : null;

/// Currencies with no minor unit, so 500 means 500, not 5.00.
const _zeroDecimal = {'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF', 'PYG', 'RWF'};

/// What staff type into a price box, such as "2.50", as minor units. Throws FormatException.
int parseMoney(String input, String currency) {
  final n = double.tryParse(input.trim().replaceAll(',', '.'));
  if (n == null || n < 0 || !n.isFinite) throw const FormatException('Enter an amount such as 2.50');
  return _zeroDecimal.contains(currency) ? n.round() : (n * 100).round();
}

String formatMoney(int minor, String currency) {
  if (_zeroDecimal.contains(currency)) return '$currency $minor';
  final whole = minor ~/ 100;
  final cents = (minor % 100).toString().padLeft(2, '0');
  return '$currency $whole.$cents';
}

/// YYYY-MM-DD, as the slots endpoint expects.
String isoDate(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

String hhmm(DateTime d) => '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
