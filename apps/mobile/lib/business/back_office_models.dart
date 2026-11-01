/// What the back office shows about money: payments, payouts, disputes and the business's
/// plan, as the API returns them. Amounts are in minor units.
library;

/// What staff can move an order to next, with the button label. Mirrors the API's rules.
const orderNextSteps = <String, List<(String, String)>>{
  'placed': [('accepted', 'Accept'), ('rejected', 'Decline')],
  'accepted': [('ready', 'Mark ready'), ('cancelled', 'Cancel')],
  'ready': [('completed', 'Collected'), ('cancelled', 'Cancel')],
};

const disputeStatusLabels = {
  'warning_needs_response': 'Bank asking questions',
  'warning_under_review': 'Bank reviewing',
  'warning_closed': 'Closed without a dispute',
  'needs_response': 'Needs your response',
  'under_review': 'Bank deciding',
  'won': 'You won',
  'lost': 'You lost',
};

const payoutCountries = ['GB', 'IE', 'US', 'CA', 'AU', 'NZ', 'DE', 'FR', 'ES', 'IT', 'NL', 'IN', 'SG'];

int _int(Object? v) => (v as num?)?.toInt() ?? 0;
DateTime? _date(Object? v) => v == null ? null : DateTime.parse(v as String);

class PayoutAccount {
  PayoutAccount({required this.enabled, required this.connected, required this.country, required this.payoutsEnabled, required this.onlinePayments});
  factory PayoutAccount.fromJson(Map<String, dynamic> j) => PayoutAccount(
        enabled: j['enabled'] as bool? ?? false,
        connected: j['connected'] as bool? ?? false,
        country: j['country'] as String?,
        payoutsEnabled: j['payoutsEnabled'] as bool? ?? false,
        onlinePayments: j['onlinePayments'] as bool? ?? false,
      );

  /// Online payments are switched on for the whole platform.
  final bool enabled;
  final bool connected;
  final String? country;
  final bool payoutsEnabled;

  /// Customers can pay this business by card.
  final bool onlinePayments;
}

class Payout {
  Payout({required this.id, required this.amountMinor, required this.currency, required this.status, required this.arrivalDate});
  factory Payout.fromJson(Map<String, dynamic> j) => Payout(
        id: j['id'] as String,
        amountMinor: _int(j['amountMinor']),
        currency: j['currency'] as String,
        status: j['status'] as String,
        arrivalDate: _date(j['arrivalDate']),
      );
  final String id;
  final int amountMinor;
  final String currency;
  final String status;
  final DateTime? arrivalDate;
}

class PaymentRecord {
  PaymentRecord({
    required this.id,
    required this.orderId,
    required this.status,
    required this.amountMinor,
    required this.refundedMinor,
    required this.disputedMinor,
    required this.feeMinor,
    required this.currency,
    required this.createdAt,
  });
  factory PaymentRecord.fromJson(Map<String, dynamic> j) => PaymentRecord(
        id: j['id'] as String,
        orderId: j['orderId'] as String?,
        status: j['status'] as String,
        amountMinor: _int(j['amountMinor']),
        refundedMinor: _int(j['refundedMinor']),
        disputedMinor: _int(j['disputedMinor']),
        feeMinor: _int(j['feeMinor']),
        currency: j['currency'] as String,
        createdAt: DateTime.parse(j['createdAt'] as String),
      );
  final String id;

  /// Null for a booking deposit.
  final String? orderId;
  final String status;
  final int amountMinor;
  final int refundedMinor;
  final int disputedMinor;
  final int feeMinor;
  final String currency;
  final DateTime createdAt;
}

class PaymentTotals {
  PaymentTotals({required this.currency, required this.paidMinor, required this.refundedMinor, required this.disputedMinor, required this.feesMinor});
  factory PaymentTotals.fromJson(Map<String, dynamic> j) => PaymentTotals(
        currency: j['currency'] as String,
        paidMinor: _int(j['paidMinor']),
        refundedMinor: _int(j['refundedMinor']),
        disputedMinor: _int(j['disputedMinor']),
        feesMinor: _int(j['feesMinor']),
      );
  final String currency;
  final int paidMinor;
  final int refundedMinor;
  final int disputedMinor;
  final int feesMinor;
}

class Dispute {
  Dispute({required this.id, required this.orderId, required this.amountMinor, required this.currency, required this.reason, required this.status, required this.canRespond, required this.evidenceDueBy});
  factory Dispute.fromJson(Map<String, dynamic> j) => Dispute(
        id: j['id'] as String,
        orderId: j['orderId'] as String?,
        amountMinor: _int(j['amountMinor']),
        currency: j['currency'] as String,
        reason: j['reason'] as String? ?? '',
        status: j['status'] as String,
        canRespond: j['canRespond'] as bool? ?? false,
        evidenceDueBy: _date(j['evidenceDueBy']),
      );
  final String id;
  final String? orderId;
  final int amountMinor;
  final String currency;
  final String reason;
  final String status;
  final bool canRespond;
  final DateTime? evidenceDueBy;
}

class Plan {
  Plan({required this.id, required this.code, required this.name, required this.priceMinor, required this.currency, required this.interval});
  factory Plan.fromJson(Map<String, dynamic> j) => Plan(
        id: j['id'] as String,
        code: j['code'] as String,
        name: j['name'] as String,
        priceMinor: _int(j['priceMinor']),
        currency: j['currency'] as String,
        interval: j['interval'] as String,
      );
  final String id;
  final String code;
  final String name;
  final int priceMinor;
  final String currency;

  /// 'month' or 'year'.
  final String interval;
}

class BusinessSubscription {
  BusinessSubscription({required this.enabled, required this.plan, required this.status, required this.cancelAtPeriodEnd, required this.currentPeriodEnd, required this.staffLimit, required this.catalogueLimit});
  factory BusinessSubscription.fromJson(Map<String, dynamic> j) {
    final s = j['subscription'] as Map<String, dynamic>?;
    final limits = j['limits'] as Map<String, dynamic>;
    return BusinessSubscription(
      enabled: j['enabled'] as bool? ?? false,
      plan: s == null ? null : Plan.fromJson(s['plan'] as Map<String, dynamic>),
      status: s?['status'] as String?,
      cancelAtPeriodEnd: s?['cancelAtPeriodEnd'] as bool? ?? false,
      currentPeriodEnd: _date(s?['currentPeriodEnd']),
      staffLimit: _int(limits['staff']),
      catalogueLimit: _int(limits['catalogue']),
    );
  }
  final bool enabled;

  /// Null on the free plan.
  final Plan? plan;
  final String? status;
  final bool cancelAtPeriodEnd;
  final DateTime? currentPeriodEnd;
  final int staffLimit;
  final int catalogueLimit;
}

class PlanChangePreview {
  PlanChangePreview({required this.plan, required this.amountDueNowMinor, required this.currency, required this.intervalChanges});
  factory PlanChangePreview.fromJson(Map<String, dynamic> j) => PlanChangePreview(
        plan: Plan.fromJson(j['plan'] as Map<String, dynamic>),
        amountDueNowMinor: _int(j['amountDueNowMinor']),
        currency: j['currency'] as String,
        intervalChanges: j['intervalChanges'] as bool? ?? false,
      );
  final Plan plan;

  /// Charged now; below zero is credit towards later bills.
  final int amountDueNowMinor;
  final String currency;
  final bool intervalChanges;
}
