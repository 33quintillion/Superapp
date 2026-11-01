import 'package:flutter_contacts/flutter_contacts.dart';

/// One person in the phone's address book: only what's needed to find them here.
class AddressBookEntry {
  const AddressBookEntry({required this.name, this.emails = const [], this.phones = const []});
  final String name;
  final List<String> emails;
  final List<String> phones;
}

/// The phone's address book. Read only when the person asks, and only after the system
/// permission prompt; tests replace [instance].
abstract class ContactsBook {
  static ContactsBook instance = PlatformContactsBook();

  /// The contacts, or null if the person didn't allow access.
  Future<List<AddressBookEntry>?> read();
}

class PlatformContactsBook implements ContactsBook {
  @override
  Future<List<AddressBookEntry>?> read() async {
    final status = await FlutterContacts.permissions.request(PermissionType.read);
    if (status != PermissionStatus.granted && status != PermissionStatus.limited) return null;
    final contacts = await FlutterContacts.getAll(properties: {ContactProperty.phone, ContactProperty.email});
    return [
      for (final c in contacts)
        AddressBookEntry(
          name: c.displayName ?? '',
          emails: [for (final e in c.emails) e.address],
          // Android gives numbers in international form when it can; the API skips the rest.
          phones: [for (final p in c.phones) p.normalizedNumber ?? p.number],
        ),
    ];
  }
}
