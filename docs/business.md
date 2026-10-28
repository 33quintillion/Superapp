# Businesses, orders and bookings

Stage 7 lets anyone open a business page, sell from a catalogue for pickup, and take bookings. Customers pay at pickup, or by card once the business has set up payouts (Stage 8, [`payments.md`](payments.md)). Endpoints are in [`api.md`](api.md#businesses).

## Staff roles
Each business has one owner, any number of managers and staff. The table lives in `apps/api/src/business/roles.ts` and every back-office request checks it; `unit.spec.ts › business staff roles` pins it.

| Permission | Owner | Manager | Staff |
| --- | --- | --- | --- |
| See the back office, staff list, orders and bookings | ✓ | ✓ | ✓ |
| Accept, prepare and hand over orders; cancel bookings; record who came | ✓ | ✓ | ✓ |
| Edit the profile, opening hours, catalogue and services | ✓ | ✓ | |
| See payments, payouts and disputes; refund orders and deposits; answer disputes | ✓ | ✓ | |
| Set up payouts; choose, change and cancel the plan | ✓ | | |
| Invite and remove staff | ✓ | ✓ (staff only) | |
| Invite, promote and remove managers | ✓ | | |
| Hand over ownership (to a manager), close the business | ✓ | | |

- People are **invited** by username and only become staff when they accept. Declining and leaving are the same action. The owner can't leave without handing over first.
- Nobody changes their own role or anyone at or above their rank.
- People who aren't staff get 404 on every back-office route, so a business's internals can't be probed.
- When platform staff suspend a business, customers can't see it. Its staff still can, with the reason, and can wind down orders but not change anything.
- If the owner deletes their account, the longest-serving manager becomes owner. With no manager, the business closes.

## Catalogue and orders
- Prices are in minor units (cents) of the business's currency, set when the business is created.
- Stock is optional per item. An order takes stock in the same database transaction that creates it, and two people can't buy the last one (`business.e2e › never sells the last item twice`).
- The order's prices come from the catalogue on the server. The client sends item ids and quantities only. Names and prices are copied into the order, so later edits don't change past orders.
- Each order carries a `clientId`; sending the same one again returns the first order instead of a duplicate.
- Statuses: `placed → accepted → ready → completed`. The business can decline a placed order (`rejected`) or cancel an accepted or ready one. The customer can cancel only while it's `placed`. Rejected and cancelled orders give their stock back.
- Staff see the customer's username and display name, never their email or phone.
- Changes reach both sides live over the WebSocket (`order.updated` to the customer, `business.order.*` to staff).

## Bookings
- A business sets opening hours per weekday in its own time zone (several periods a day are fine, overlaps are refused).
- Each service has a length and a capacity (how many people at once). Free start times are steps of the service's length from each opening, ending by closing time, in the future and up to 90 days ahead.
- Booking locks the service while it counts who is already booked, so a slot can't be overbooked when people book at the same moment (`business.e2e › never overbooks`).
- A booking can be cancelled by the customer or the business before it starts. After the start, staff record `completed` or `no_show`.
- A service can ask for a **deposit**, paid by card when booking (up to the full price; needs payouts set up). The booking holds its place as `pending_payment` until the deposit is paid, and is given back if the checkout runs out. The deposit is refunded if the business cancels, or if the customer cancels at least `freeCancelHours` (default 24) before the start; after that, and for a no-show, the business keeps it. Managers can still refund some or all of it. Details in [`payments.md`](payments.md#booking-deposits).

## Not built yet
- Delivery (only pickup), table service, tips, taxes and receipts.
- Photos on items and businesses: waiting for the media-scanning provider, like all public media.
- Business verification checks. The "Verified" badge is set by an admin by hand.
- Managing a business from the phone app. The Flutter app can find businesses, order, book and see your orders; the back office is on the web.
- Staff notifications for new orders outside the open back office (push for businesses).
