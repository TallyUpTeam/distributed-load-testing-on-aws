/*******************************************************************************
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved. 
 *
 * Licensed under the Amazon Software License (the "License").
 * You may not use this file except in compliance with the License.
 * A copy of the License is located at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0    
 *
 * or in the "license" file accompanying this file. This file is distributed
 * on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either
 * express or implied. See the License for the specific language governing
 * permissions and limitations under the License.
 *
 ********************************************************************************/
import React from 'react';
import { API } from 'aws-amplify';
import 'brace';
import { Col, Row, Button, FormGroup, Label, Input, FormText, Spinner, InputGroup } from 'reactstrap';
import 'brace/theme/github';
import { generateSpecialEvents } from '../../generateSpecialEvents';

class Create extends React.Component {
    constructor(props) {
        super(props);
        if (this.props.location.state.data.testId) {
            console.log('Test id:', this.props.location.state.data.testId)
            this.state = {
                isLoading: false,
                runningTasks: false,
                testId: this.props.location.state.data.testId,
                formValues: {
                    testName:               this.props.location.state.data.testName,
                    testDescription:        this.props.location.state.data.testDescription,
                    taskCount:              this.props.location.state.data.taskCount,
                    concurrency:            this.props.location.state.data.concurrency,
                    rampUp:                 this.props.location.state.data.rampUp,
                    rampUpUnits:            this.props.location.state.data.rampUpUnits,
                    holdFor:                this.props.location.state.data.holdFor,
                    holdForUnits:           this.props.location.state.data.holdForUnits,
                    rampDown:               this.props.location.state.data.rampDown,
                    rampDownUnits:          this.props.location.state.data.rampDownUnits,
                    stack:                  this.props.location.state.data.stack,
                    playAsync:              this.props.location.state.data.playAsync,
                    maxHiddenTournaments:   this.props.location.state.data.maxHiddenTournaments,
                    specialEventSpecs:      this.props.location.state.data.specialEventSpecs
                }
            }
        } else {
            this.state = {
                isLoading: false,
                runningTasks: false,
                testId: null,
                formValues: {
                    testName: '',
                    testDescription: '',
                    taskCount: 0,
                    concurrency: 0,
                    rampUp: 0,
                    rampUpUnits: 'm',
                    holdFor: 0,
                    holdForUnits: 'm',
                    rampDown: 0,
                    rampDownUnits: 'm',
                    stack: '',
                    playAsync: true,
                    maxHiddenTournaments: 5,
                    specialEventSpecs: {
                        delayStarts: false,
                        minDelayMins: 0,
                        maxDelayMins: 10,
                        surge: true,
                        surgeLength: '30m',
                        season: true,
                        seasonJoinWindow: '30m',
                        realTime: true,
                        realTimeJoinWindow: '30m',
                        miniRoyaleCount: 7,
                        miniRoyaleJoinWindow: '30m',
                        bestOfBlasteroids: true,
                        bestOfCrystalCaverns: true,
                        bestOfMagnetMadness: true,
                        bestOfMonkeyBusiness: true,
                        hiddenEventCount: 5
                    }
                }
            };
        }
        this.form = React.createRef();
        this.handleSubmit = this.handleSubmit.bind(this);
        this.handleInputChange = this.handleInputChange.bind(this);
        this.setFormValue = this.setFormValue.bind(this);
        this.handleSpecInputChange = this.handleSpecInputChange.bind(this);
        this.setSpecFormValue = this.setSpecFormValue.bind(this);
        this.parseJson = this.parseJson.bind(this);
        this.listTasks = this.listTasks.bind(this);
        console.log('Form values:', this.state.formValues);
    }

    parseJson(str) {
        try {
            return JSON.parse(str)
        } catch (err) {
            return false;
        }
    }

    handleSubmit = async () => {
        const values = this.state.formValues;

        if (!this.form.current.reportValidity()) {
            return false;
        }
        this.setState({ isLoading: true })
        console.log('Values:', values);

        try {
            let payload = {
                testName: values.testName,
                testDescription: values.testDescription,
                taskCount: values.taskCount,
                testConfig: {
                    testName: values.testName,
                    executor: 'ramping-vus',
                    startVus: 1,
                    vusMax: values.concurrency,
                    stages: [
                        { duration: String(values.rampUp).concat(values.rampUpUnits), target: values.concurrency },
                        { duration: String(values.holdFor).concat(values.holdForUnits), target: values.concurrency },
                        { duration: String(values.rampDown).concat(values.rampDownUnits), target: 0 }
                    ],
                    gracefulStop: '5m',
                    gracefulRampDown: '5m',
                    stack: values.stack,
                    playAsync: values.playAsync,
                    maxHiddenTournaments: values.maxHiddenTournaments,
                    events: generateSpecialEvents(values.specialEventSpecs)
                }
            };

            if (this.state.testId) {
                payload.testId = this.state.testId;
            }

            console.log('Payload', payload);
            const response = await API.post('dlts', '/scenarios', { body: payload });
            console.log('Scenario created successfully', response);
            this.props.history.push("/");
        } catch (err) {
            console.error('Failed to create scenario', err);
            this.setState({ isLoading: false });
        }
    }

    setFormValue(key, value) {
        const formValues = this.state.formValues;
        formValues[key] = value;
        this.setState({ formValues });
    }

    handleInputChange(event) {
        const value = event.target.value;
        const name = event.target.name;
        this.setFormValue(name, value);
    }

    setSpecFormValue(key, value) {
        const specValues = this.state.formValues.specialEventSpecs;
        specValues[key] = value;
        this.setState({ formValues: { specialEventSpecs: specValues } });
    }

    handleSpecInputChange(event) {
        const value = event.target.value;
        const name = event.target.name;
        this.setSpecFormValue(name, value);
    }

    listTasks = async () => {
        try {
            const data = await API.get('dlts', '/tasks');
            if (data.length !== 0) {
                this.setState({ runningTasks: true });
            }
        } catch (err) {
            alert(err);
        }
    };

    componentDidMount() {
        this.listTasks();
    };

    render() {
        const warning = (
            <div>
                <div className="box">
                    <h1>Create a Load Test</h1>
                </div>
                <p className="warning">Warning there is a test running, multiple concurrent tests is currently not supported to avoid hitting the AWS Fargate task limits. Please wait for the test to finish before submitting a new test!</p>
            </div>
        )

        const heading = (
            <div className="box">
                <h1>Create a Load Test</h1>
            </div>
        )

        const createTestForm = (
            <div>
                <Row>
                    <Col sm="6">
                        <div className="box">
                            <h3>General Settings</h3>
                            <FormGroup>
                                <Label for="testName">Name</Label>
                                <Input
                                    value={this.state.formValues.testName}
                                    type="text"
                                    name="testName"
                                    id="testName"
                                    required
                                    onChange={this.handleInputChange}
                                />
                                <FormText color="muted">
                                    The name of your load test, doesn't have to be unique.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="testDescription">Description</Label>
                                <Input
                                    value={this.state.formValues.testDescription}
                                    type="textarea"
                                    name="testDescription"
                                    id="testDescription"
                                    required
                                    onChange={this.handleInputChange}
                                />
                                <FormText color="muted">
                                    Short description of the test scenario.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="taskCount">Task Count</Label>
                                <Input
                                    value={this.state.formValues.taskCount}
                                    className="form-short"
                                    type="number"
                                    name="taskCount"
                                    id="taskCount"
                                    max={50}
                                    min={1}
                                    step={1}
                                    required
                                    onChange={this.handleInputChange}
                                />
                                <FormText color="muted">
                                    Number of docker containers that will be launched in the Fargate cluster to run the
                                    test scenario, max value 50.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="concurrency">Concurrency</Label>
                                <Input
                                    value={this.state.formValues.concurrency}
                                    className="form-short"
                                    type="number"
                                    min={1}
                                    step={1}
                                    name="concurrency"
                                    id="concurrency"
                                    required
                                    onChange={this.handleInputChange}
                                />
                                <FormText color="muted">
                                    The number of concurrent virtual users spawned per task.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="rampUp">Ramp Up</Label>
                                <InputGroup className="input-group-short">
                                    <Input
                                        value={this.state.formValues.rampUp}
                                        className="form-short"
                                        type="number"
                                        name="rampUp"
                                        id="rampUp"
                                        required
                                        onChange={this.handleInputChange}
                                    />
                                    &nbsp;
                                    <Input
                                        type="select"
                                        className="form-short"
                                        name="rampUpUnits"
                                        value={this.state.formValues.rampUpUnits}
                                        id="rampUpUnits"
                                        onChange={this.handleInputChange}
                                    >
                                        <option value="m">minutes</option>
                                        <option value="s">seconds</option>
                                    </Input>
                                </InputGroup>
                                <FormText color="muted">
                                    The time to reach target concurrency.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="holdFor">Hold For</Label>
                                <InputGroup className="input-group-short">
                                    <Input
                                        value={this.state.formValues.holdFor}
                                        className="form-short"
                                        type="number"
                                        min={1}
                                        name="holdFor"
                                        id="holdFor"
                                        required
                                        onChange={this.handleInputChange}
                                    />
                                    &nbsp;
                                    <Input
                                        type="select"
                                        value={this.state.formValues.holdForUnits}
                                        className="form-short"
                                        name="holdForUnits"
                                        id="holdForUnits"
                                        onChange={this.handleInputChange}
                                    >
                                        <option value="m">minutes</option>
                                        <option value="s">seconds</option>
                                    </Input>
                                </InputGroup>
                                <FormText color="muted">
                                    Time to hold target concurrency.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="rampDown">Ramp Down</Label>
                                <InputGroup className="input-group-short">
                                    <Input
                                        value={this.state.formValues.rampDown}
                                        className="form-short"
                                        type="number"
                                        name="rampDown"
                                        id="rampDown"
                                        required
                                        onChange={this.handleInputChange}
                                    />
                                    &nbsp;
                                    <Input
                                        type="select"
                                        className="form-short"
                                        name="rampDownUnits"
                                        value={this.state.formValues.rampDownUnits}
                                        id="rampDownUnits"
                                        onChange={this.handleInputChange}
                                    >
                                        <option value="m">minutes</option>
                                        <option value="s">seconds</option>
                                    </Input>
                                </InputGroup>
                                <FormText color="muted">
                                    The time to ramp down concurrency.
                                </FormText>
                            </FormGroup>
                        </div>
                    </Col>
                    <Col sm="6">
                        <div className="box">
                            <h3>Scenario</h3>
                            <FormGroup>
                                <Label for="stack">Stack</Label>
                                <Input
                                    value={this.state.formValues.stack}
                                    type="text"
                                    name="stack"
                                    id="stack"
                                    required
                                    onChange={this.handleInputChange}
                                />
                                <FormText color="muted">
                                    Target TallyUP stack to run tests against (lowercase).
                                </FormText>
                            </FormGroup>
                            <FormGroup check>
                                <Input
                                    checked={this.state.formValues.playAsync}
                                    type="checkbox"
                                    name="playAsync"
                                    id="playAsync"
                                    onChange={e => this.handleInputChange({ target: { name: e.target.name, value: e.target.checked }})}
                                />
                                <Label for="playAsync" check>Play Async Games?</Label>
                                <FormText color="muted">
                                    Whether to enable playing async games or only live games.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="maxHiddenTournaments"><br/>Play Hidden Tournaments Limit</Label>
                                <Input
                                    value={this.state.formValues.maxHiddenTournaments}
                                    className="form-short"
                                    type="number"
                                    name="maxHiddenTournaments"
                                    id="maxHiddenTournaments"
                                    required
                                    onChange={this.handleInputChange}
                                />
                                <FormText color="muted">
                                    Maximum number of hidden tournaments to attempt to join.
                                </FormText>
                            </FormGroup>
                            <FormGroup check>
                                <Input
                                    checked={this.state.formValues.specialEventSpecs.delayStarts}
                                    type="checkbox"
                                    name="delayStarts"
                                    id="delayStarts"
                                    onChange={e => this.handleSpecInputChange({ target: { name: e.target.name, value: e.target.checked }})}
                                />
                                <Label for="delayStarts" check>Delay Special Event Starts?</Label>
                                <FormText color="muted">
                                    Whether to stagger the start of tournaments after the test starts.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="minDelayMins"><br/>Delay Time Min/Max</Label>
                                <InputGroup className="input-group-short">
                                    <Input
                                        value={this.state.formValues.specialEventSpecs.minDelayMins}
                                        className="form-short"
                                        type="number"
                                        name="minDelayMins"
                                        id="minDelayMins"
                                        required
                                        onChange={this.handleSpecInputChange}
                                    />
                                    &nbsp;-&nbsp;
                                    <Input
                                        value={this.state.formValues.specialEventSpecs.maxDelayMins}
                                        className="form-short"
                                        type="number"
                                        name="maxDelayMins"
                                        id="maxDelayMins"
                                        required
                                        onChange={this.handleSpecInputChange}
                                    />
                                </InputGroup>
                                <FormText color="muted">
                                    Minimum and maximum delay, in minutes.
                                </FormText>
                            </FormGroup>
                            <FormGroup check>
                                <Input
                                    checked={this.state.formValues.specialEventSpecs.surge}
                                    type="checkbox"
                                    name="surge"
                                    id="surge"
                                    onChange={e => this.handleSpecInputChange({ target: { name: e.target.name, value: e.target.checked }})}
                                />
                                <Label for="surge" check>Run Surge Event?</Label>
                                <FormText color="muted">
                                    Whether to run a Surge during the test.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="surgeLength"><br/>Surge Length</Label>
                                <Input
                                    value={this.state.formValues.specialEventSpecs.surgeLength}
                                    type="text"
                                    name="surgeLength"
                                    id="surgeLength"
                                    required
                                    onChange={this.handleSpecInputChange}
                                />
                                <FormText color="muted">
                                    Length of Surge, in "XXhXXmXXs" format (all parts optional).
                                </FormText>
                            </FormGroup>
                            <FormGroup check>
                                <Input
                                    checked={this.state.formValues.specialEventSpecs.season}
                                    type="checkbox"
                                    name="season"
                                    id="season"
                                    onChange={e => this.handleSpecInputChange({ target: { name: e.target.name, value: e.target.checked }})}
                                />
                                <Label for="season" check>Run Season Tournament?</Label>
                                <FormText color="muted">
                                    Whether to run a season tournament during the test.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="seasonJoinWindow"><br/>Season Join Window Length</Label>
                                <Input
                                    value={this.state.formValues.specialEventSpecs.seasonJoinWindow}
                                    type="text"
                                    name="seasonJoinWindow"
                                    id="seasonJoinWindow"
                                    required
                                    onChange={this.handleSpecInputChange}
                                />
                                <FormText color="muted">
                                    Length of season join window, in "XXhXXmXXs" format (all parts optional).
                                </FormText>
                            </FormGroup>
                            <FormGroup check>
                                <Input
                                    checked={this.state.formValues.specialEventSpecs.realTime}
                                    type="checkbox"
                                    name="realTime"
                                    id="realTime"
                                    onChange={e => this.handleSpecInputChange({ target: { name: e.target.name, value: e.target.checked }})}
                                />
                                <Label for="realTime" check>Run Real-Time Tournament?</Label>
                                <FormText color="muted">
                                    Whether to run a real-time tournament during the test.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="realTimeJoinWindow"><br/>Real-Time Join Window Length</Label>
                                <Input
                                    value={this.state.formValues.specialEventSpecs.realTimeJoinWindow}
                                    type="text"
                                    name="realTimeJoinWindow"
                                    id="realTimeJoinWindow"
                                    required
                                    onChange={this.handleSpecInputChange}
                                />
                                <FormText color="muted">
                                    Length of real-time join window, in "XXhXXmXXs" format (all parts optional).
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="miniRoyaleCount">Mini-Royale Tournaments</Label>
                                <Input
                                    value={this.state.formValues.specialEventSpecs.miniRoyaleCount}
                                    className="form-short"
                                    type="number"
                                    name="miniRoyaleCount"
                                    id="miniRoyaleCount"
                                    required
                                    onChange={this.handleSpecInputChange}
                                />
                                <FormText color="muted">
                                    Number of mini-royale tournaments to run during test, or 0.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label for="miniRoyaleJoinWindow">Mini-Royale Join Window Length</Label>
                                <Input
                                    value={this.state.formValues.specialEventSpecs.miniRoyaleJoinWindow}
                                    type="text"
                                    name="miniRoyaleJoinWindow"
                                    id="miniRoyaleJoinWindow"
                                    required
                                    onChange={this.handleSpecInputChange}
                                />
                                <FormText color="muted">
                                    Length of mini-royale join window, in "XXhXXmXXs" format (all parts optional).
                                    <br/>
                                    This value will also be used for best-of and hidden tournaments, below.
                                </FormText>
                            </FormGroup>
                            <FormGroup>
                                <Label>Best Of Tournaments?</Label>
                                <FormText color="muted">
                                    Whether to run best-of tournament(s) during the test.
                                </FormText>
                            </FormGroup>
                            <FormGroup check inline>
                                <Input
                                    checked={this.state.formValues.specialEventSpecs.bestOfBlasteroids}
                                    type="checkbox"
                                    name="bestOfBlasteroids"
                                    id="bestOfBlasteroids"
                                    onChange={e => this.handleSpecInputChange({ target: { name: e.target.name, value: e.target.checked }})}
                                />
                                <Label check>Blasteroids</Label>
                            </FormGroup>
                            <FormGroup check inline>
                                <Input
                                    checked={this.state.formValues.specialEventSpecs.bestOfCrystalCaverns}
                                    type="checkbox"
                                    name="bestOfCrystalCaverns"
                                    id="bestOfCrystalCaverns"
                                    onChange={e => this.handleSpecInputChange({ target: { name: e.target.name, value: e.target.checked }})}
                                />
                                <Label check>Crystal Caverns</Label>
                            </FormGroup>
                            <FormGroup check inline>
                                <Input
                                    checked={this.state.formValues.specialEventSpecs.bestOfMagnetMadness}
                                    type="checkbox"
                                    name="bestOfMagnetMadness"
                                    id="bestOfMagnetMadness"
                                    onChange={e => this.handleSpecInputChange({ target: { name: e.target.name, value: e.target.checked }})}
                                />
                                <Label check>Magnet Madness</Label>
                            </FormGroup>
                            <FormGroup check inline>
                                <Input
                                    checked={this.state.formValues.specialEventSpecs.bestOfMonkeyBusiness}
                                    type="checkbox"
                                    name="bestOfMonkeyBusiness"
                                    id="bestOfMonkeyBusiness"
                                    onChange={e => this.handleSpecInputChange({ target: { name: e.target.name, value: e.target.checked }})}
                                />
                                <Label check>Monkey Business</Label>
                            </FormGroup>
                            <FormGroup>
                                <Label for="hiddenEventCount"><br/>Hidden Tournaments</Label>
                                <Input
                                    value={this.state.formValues.specialEventSpecs.hiddenEventCount}
                                    className="form-short"
                                    type="number"
                                    name="hiddenEventCount"
                                    id="hiddenEventCount"
                                    required
                                    onChange={this.handleSpecInputChange}
                                />
                                <FormText color="muted">
                                    Number of hidden tournaments to run during test, or 0.
                                </FormText>
                            </FormGroup>
                            <Button
                                className="submit"
                                size="sm"
                                onClick={this.handleSubmit}
                                disabled={this.state.runningTasks}
                            >
                                Submit
                            </Button>
                        </div>
                    </Col>
                </Row>
            </div>
        );

        return (
            <div>
                <form ref={this.form} onSubmit={e => e.preventDefault()}>
                    {this.state.runningTasks ? warning : heading}
                    <div>
                        {this.state.isLoading ? <div className="loading"><Spinner color="secondary" /></div> : createTestForm}
                    </div>
                </form>
            </div>
        )
    }
}

export default Create;
