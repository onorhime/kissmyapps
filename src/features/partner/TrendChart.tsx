import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { formatMetric, metricDefinitions } from './reporting'
import type { PeriodMetric, ReportRow } from './reporting'

const colors = ['#366349', '#80532d', '#595b9b']
const dashes = [undefined, '7 4', '2 4']

export default function TrendChart({
  rows,
  series,
  currency,
}: {
  rows: ReportRow[]
  series: PeriodMetric[]
  currency: boolean
}) {
  const data = rows.map((row) => ({ label: row.label, ...row.values }))
  return (
    <ResponsiveContainer width="100%" height={245} initialDimension={{ width: 650, height: 245 }}>
      <LineChart data={data} margin={{ top: 18, right: 14, bottom: 0, left: 0 }} accessibilityLayer>
        <CartesianGrid strokeDasharray="4 5" vertical={false} stroke="#e9ede8" />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          minTickGap={48}
          tick={{ fill: '#5c6b55', fontSize: 12 }}
          dy={10}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          width={64}
          tick={{ fill: '#5c6b55', fontSize: 12 }}
          tickFormatter={(value) =>
            currency
              ? new Intl.NumberFormat('en-US', {
                  style: 'currency',
                  currency: 'USD',
                  notation: 'compact',
                  maximumFractionDigits: 1,
                }).format(Number(value) / 100)
              : new Intl.NumberFormat('en-US', { notation: 'compact' }).format(Number(value))
          }
        />
        <Tooltip
          contentStyle={{
            borderRadius: 12,
            border: '1px solid #7a896f',
            fontSize: 12,
            boxShadow: '0 8px 30px #17251c12',
            maxWidth: 260,
          }}
          formatter={(value, name) => [
            formatMetric(name as PeriodMetric, value == null ? null : Number(value)),
            metricDefinitions[name as PeriodMetric]?.label ?? name,
          ]}
          filterNull={false}
          isAnimationActive={false}
        />
        {series.map((key, index) => (
          <Line
            key={key}
            type="linear"
            dataKey={key}
            name={key}
            stroke={colors[index]}
            strokeDasharray={dashes[index]}
            strokeWidth={2.5}
            dot={rows.length <= 14 ? { r: 2.5 } : false}
            activeDot={{ r: 5 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  )
}
