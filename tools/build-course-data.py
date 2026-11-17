#!/usr/bin/env python3
"""Turns OpenGolfAPI course records into server/course-data.json (the scorecards GolfBuddy ships with).

Run by hand when a course is added: python3 tools/build-course-data.py <dir with full_*.json>
Scorecard data (c) OpenStreetMap contributors (ODbL 1.0) via OpenGolfAPI.
"""
import json, sys, os

SRC = sys.argv[1] if len(sys.argv) > 1 else '/tmp/ogapi'
# Our course name -> (OpenGolfAPI file, extra facts checked against the course's own site)
COURSES = {
  'Rancho Park': ('full_rancho.json', {
    'address': '10460 W Pico Blvd, Los Angeles, CA 90064', 'phone': '(310) 838-7373', 'website': 'https://golf.lacity.gov/course_rancho_park/',
    'notes': [
      'L.A. City\'s flagship muni (William P. Bell, 1949); it hosted the L.A. Open for years.',
      'Back-nine starts are only offered in the first hour of daylight.',
      'Lighted range, practice greens, snack bar and coffee shop; the separate 9-hole par-3 is next door.',
      'Weekend green fee is a few dollars higher before 9 a.m.',
    ]}),
  'Griffith Park - Wilson': ('full_wilson.json', {
    'address': '5500 Griffith Park Dr, Los Angeles, CA 90027', 'phone': '(323) 663-2555', 'website': 'https://golf.lacity.gov/wilson-golf-course/',
    'notes': [
      'Longest L.A. City course: 7,002 yards from the black tees. Tree-lined, gently sloping fairways.',
      'Wilson and Harding start from the same clubhouse and there are few signs, so confirm your first tee with the starter.',
      'Shared lighted two-level range, golf shop and restaurant (restaurant (323) 661-7212).',
    ]}),
  'Griffith Park - Harding': ('full_harding.json', {
    'address': '5500 Griffith Park Dr, Los Angeles, CA 90027', 'phone': '(323) 663-2555', 'website': 'https://golf.lacity.gov/?p=453',
    'notes': [
      'Opened 1923. Narrower than Wilson, with tough approaches into guarded greens: accuracy over distance.',
      'Some out-of-bounds lines where Harding borders Wilson are hard to see from the tee.',
      'Deer are common, coyotes too. Shares the clubhouse and range with Wilson.',
    ]}),
  'Roosevelt': ('full_roosevelt.json', {
    'address': '2650 N Vermont Ave, Los Angeles, CA 90027', 'phone': '(323) 665-2011', 'website': 'https://golf.lacity.gov/course_roosevelt/',
    'notes': [
      '9-hole executive, par 33, about 2,500 yards. Walking only: no carts and no cart paths, and it is hilly.',
      'Across the street from the Greek Theatre, with views of the Observatory and downtown.',
      'Fivesomes are allowed, so 9 holes can take 2.5 hours or more. Café: (323) 545-0444.',
    ]}),
  'Los Verdes Golf Course': ('full_losverdes.json', {
    'address': '7000 W Los Verdes Dr, Rancho Palos Verdes, CA 90275', 'phone': '(310) 377-7888', 'website': 'http://www.losverdesgc.com/',
    'notes': [
      'L.A. County course on the Palos Verdes bluffs: ocean and Catalina views on most holes.',
      'Known for slow rounds (5 to 6 hours on weekends, with fivesomes). The earliest tee times play fastest.',
      'Ocean breeze picks up in the afternoon and marine fog can roll in late in the day.',
      'Full range, putting and chipping greens. Ocean View Grill: ext. 42 on the main number.',
    ]}),
  'Soule Park Golf Course': ('full_soule.json', {
    'address': '1033 E Ojai Ave, Ojai, CA 93023', 'phone': '(805) 646-5633', 'website': 'https://www.soulepark.com/',
    'notes': [
      'Gil Hanse redesign with mountain backdrops on every hole; very walkable.',
      'Winter mornings in the Ojai valley often bring frost delays, so call ahead for an early tee time from December to February.',
      'Tees are named for local crops: Oak (back), Orange, Avocado, Lime, Lemon (forward). Orange is about the usual blue.',
      'Afternoon wind can pick up in the valley.',
    ]}),
}

out = {}
for name, (fname, extra) in COURSES.items():
    d = json.load(open(os.path.join(SRC, fname)))
    hs = d.get('holes_data') or []
    tees = []
    seen = set()
    for t in d.get('tees') or []:
        if t['gender'] != 'Male':
            continue  # the men's ratings; women's ratings use the same yardages
        key = t['tee_name'].lower().replace(' (18-hole)', '')
        if key in seen: continue
        seen.add(key)
        yards = [((h.get('yardages') or {}).get(key)) for h in hs]
        tees.append({'name': t['tee_name'].replace(' (18-hole)', ''), 'rating': t['course_rating'], 'slope': t['slope'], 'par': t['par'],
                     'yards': t['yardage'], 'holes': yards if all(isinstance(y, int) for y in yards) else None})
    tees.sort(key=lambda t: -(t['yards'] or 0))
    holes = [{'par': h['par'], 'hcp': h.get('handicap_index')} for h in hs]
    assert len(holes) in (9, 18), name
    assert sum(h['par'] for h in holes) == d['par'], (name, sum(h['par'] for h in holes), d['par'])
    out[name] = {**extra, 'lat': d['lat'], 'lon': d['lng'], 'par': d['par'], 'holes': holes, 'tees': tees, 'built': d.get('year_built'),
                 'source': 'OpenGolfAPI (© OpenStreetMap contributors, ODbL)', 'ogapiId': d['id']}

dest = os.path.join(os.path.dirname(__file__), '..', 'server', 'course-data.json')
json.dump(out, open(dest, 'w'), indent=1)
print('wrote', dest, {k: (v['par'], len(v['holes']), [t['name'] for t in v['tees']]) for k, v in out.items()})
