import 'package:flutter/widgets.dart';

import 'kissmyapps.dart';

/// Records a screen view each time a page comes to the front, under its route name.
///
/// Add it to your app's navigator: `MaterialApp(navigatorObservers: [KissMyAppsObserver()])`,
/// or `GoRouter(observers: [KissMyAppsObserver()])`. Dialogs, sheets and pop-up menus are
/// not screens and are left out. A page with no name is skipped: give its route
/// `settings: RouteSettings(name: 'Lesson')`, or pass a [nameExtractor].
class KissMyAppsObserver extends NavigatorObserver {
  /// An observer that names screens with [nameExtractor] and records only the routes
  /// [routeFilter] accepts.
  KissMyAppsObserver({
    this.nameExtractor = defaultNameExtractor,
    this.routeFilter = defaultRouteFilter,
  });

  /// The screen name for a route, or null to skip it. The route's name by default.
  final String? Function(RouteSettings settings) nameExtractor;

  /// Which routes count as screens. Page routes by default.
  final bool Function(Route<dynamic>? route) routeFilter;

  String? _last;

  /// The route's name, such as `/lesson`.
  static String? defaultNameExtractor(RouteSettings settings) => settings.name;

  /// Page routes, such as `MaterialPageRoute`, and the pages go_router builds.
  static bool defaultRouteFilter(Route<dynamic>? route) => route is PageRoute;

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) => _report(route);

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) => _report(newRoute);

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) => _report(previousRoute);

  void _report(Route<dynamic>? route) {
    if (route == null || !routeFilter(route)) return;
    final name = nameExtractor(route.settings)?.trim();
    if (name == null || name.isEmpty || name == _last) return;
    _last = name;
    KissMyApps.screen(name);
  }
}
