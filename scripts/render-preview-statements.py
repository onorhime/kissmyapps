"""Render deterministic, fictional PDF fixtures. No live financial operations."""
import html
import json
from pathlib import Path
import re
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether,
)

GREEN = colors.HexColor('#366349')
INK = colors.HexColor('#2a412d')
MUTED = colors.HexColor('#5c6b55')
LINE = colors.HexColor('#dce6ce')
TINT = colors.HexColor('#edf4df')
WIDTH = 516


def plain(value):
    result = str(value)
    for source, target in {'·': '-', '–': '-', '—': '-', '×': 'x', '’': "'", '“': '"', '”': '"'}.items():
        result = result.replace(source, target)
    return result


styles = {
    'brand': ParagraphStyle('Brand', fontName='Helvetica-Bold', fontSize=24, leading=29, textColor=GREEN, spaceAfter=8),
    'title': ParagraphStyle('Title', fontName='Helvetica-Bold', fontSize=16, leading=21, textColor=INK, spaceAfter=12),
    'body': ParagraphStyle('Body', fontName='Helvetica', fontSize=10, leading=14, textColor=MUTED),
    'small': ParagraphStyle('Small', fontName='Helvetica', fontSize=9, leading=12, textColor=MUTED),
    'label': ParagraphStyle('Label', fontName='Helvetica-Bold', fontSize=10, leading=14, textColor=INK),
    'section': ParagraphStyle('Section', fontName='Helvetica-Bold', fontSize=12, leading=16, textColor=INK, spaceBefore=12, spaceAfter=10),
    'amount': ParagraphStyle('Amount', fontName='Helvetica-Bold', fontSize=10, leading=14, textColor=INK, alignment=TA_RIGHT),
}


def p(text, style='body'):
    return Paragraph(html.escape(plain(text)), styles[style])


def money(amount):
    sign = '-' if amount < 0 else ''
    return f'{sign}${abs(amount) / 100:,.2f}'


def callout(text):
    table = Table([[p(text, 'label')]], colWidths=[WIDTH])
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), TINT),
        ('BOX', (0, 0), (-1, -1), .5, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 12),
        ('RIGHTPADDING', (0, 0), (-1, -1), 12),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
    ]))
    return table


def key_values(items):
    rows = [[p(label, 'small'), p(value, 'label')] for label, value in items]
    table = Table(rows, colWidths=[157, WIDTH - 157], hAlign='LEFT')
    table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('TOPPADDING', (0, 0), (-1, -1), 4),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
    ]))
    return table


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE)
    canvas.line(48, 42, 564, 42)
    canvas.setFillColor(MUTED)
    canvas.setFont('Helvetica', 8)
    canvas.drawString(48, 29, 'UI PREVIEW ONLY - No payment occurred. Not an invoice or payment record.')
    canvas.drawRightString(564, 29, f'{doc.page}')
    canvas.restoreState()


def render(record, output):
    payout = record['payout']
    statement = payout['statement']
    if payout['status'] != 'paid' or not re.fullmatch(r'SAMPLE-2026-\d{4}', statement or ''):
        raise ValueError('Only finalized, explicitly named SAMPLE statements may be generated')
    agreement = payout['agreement']
    period = f"{payout['start']} through {payout['end']} (UTC)"
    target = output / f'{statement}.pdf'
    doc = SimpleDocTemplate(
        str(target), pagesize=letter, rightMargin=48, leftMargin=48,
        topMargin=43, bottomMargin=54, title=f'SAMPLE payout statement - {statement}',
        author='KissMyApps UI preview', subject=f"Fixture-SHA256:{record['fingerprint']}",
        pageCompression=1, invariant=1,
    )
    story = [p('KissMyApps', 'brand'), p('SAMPLE PAYOUT STATEMENT', 'title')]
    story += [callout('Fictional preview. No transfer occurred. Every amount, payment date, reference and destination in this document is illustrative.'), Spacer(1, 15)]
    story += [key_values([
        ('Statement / sample status', f'{statement} / Paid'),
        ('Period', period),
        ('Partner snapshot', agreement['partner']),
        ('Agreement / currency', f"{agreement['version']} / {agreement['currency']}"),
    ])]
    story += [p('Earnings calculation', 'section')]
    rows = [[p('Revenue basis / commission', 'label'), p('USD', 'amount')]]
    for line in payout['bridge']:
        rows.append([p(line['label']), p(money(line['amountMinor']), 'amount')])
    rows += [
        [p('Eligible net revenue', 'label'), p(money(payout['eligibleRevenueMinor']), 'amount')],
        [p('Partner earnings before adjustments (eligible x 30%)'), p(money(payout['earningsMinor']), 'amount')],
        [p('Approved adjustments (separate commission entries)'), p(money(payout['adjustmentsMinor']), 'amount')],
        [p('Final sample payout', 'label'), p(money(payout['finalMinor']), 'amount')],
    ]
    table = Table(rows, colWidths=[WIDTH - 108, 108], repeatRows=1, hAlign='LEFT')
    table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 9),
        ('RIGHTPADDING', (0, 0), (-1, -1), 9),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('LINEBELOW', (0, 0), (-1, -2), .4, LINE),
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#f6f8f0')),
        ('BACKGROUND', (0, -1), (-1, -1), TINT),
    ]))
    story += [table, Spacer(1, 12), p('Zero deductions are specific to this fixture, not a fee or tax policy. Refunds reflect the example balance impact. Live calculations must use actual Stripe settlement amounts, including non-returned fees and settlement currency conversion.', 'small')]
    story += [PageBreak(), p('Statement history & payment facts', 'title'), p(statement + ' | ' + period, 'small'), Spacer(1, 10)]
    story += [key_values([
        ('Sample payment date (UTC)', payout['paidAt']),
        ('Sample payment reference', payout['paymentReference']),
        ('Method / currency', f"{agreement['method']} / {agreement['currency']}"),
        ('Destination snapshot', agreement['destination']),
    ])]
    story += [p('Money-affecting history', 'section'), p('Simplified period-level entries: earnings, adjustments and payments are different movements.', 'small'), Spacer(1, 8)]
    for entry in payout['moneyHistory']:
        amount = ('+' if entry['amountMinor'] > 0 else '') + money(entry['amountMinor'])
        entry_title = Table([[p(f"{entry['date']} UTC | {entry['title']}", 'label'), p(amount, 'amount')]], colWidths=[WIDTH - 96, 96])
        entry_title.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0), ('RIGHTPADDING', (0, 0), (-1, -1), 0)]))
        story += [KeepTogether([entry_title, Spacer(1, 3), p(entry['detail'], 'small'), Spacer(1, 12)])]
    story += [p('Change history', 'section')]
    for entry in payout['changes']:
        story += [p(f"{entry['date']} UTC - {entry['label']}", 'small'), Spacer(1, 6)]
    story += [Spacer(1, 10), callout('Paid periods stay locked. Later refunds or corrections appear in a new open period with their own entries. This statement keeps its original agreement, identity and destination snapshots.')]
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(f'Generated {target.name}')


if __name__ == '__main__':
    destination = Path(sys.argv[1]).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    for item in json.load(sys.stdin):
        render(item, destination)
